import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { SignerClient } from '@aws-sdk/client-signer';

import {
  applyCodeSigningConfig,
  CUSTOM_RESOURCE_ARTIFACT_NAME,
  isFrameworkCustomResource,
  type ApplyResult,
  type CfnResource,
} from './cloudformation';
import { configSchema, resolveSignerConfig } from './config';
import { assertBucketExists, getActiveProfileVersionArn, signArtifact, SigningError } from './signing';
import type { Logger, RawSignerConfig, ResolvedSignerConfig, SigningTarget } from './types';

interface ServerlessFunction {
  name?: string;
  image?: unknown;
  package?: { artifact?: string };
}

interface ServerlessLike {
  serviceDir?: string;
  config?: { servicePath?: string };
  cli?: { log(message: string): void };
  configSchemaHandler: {
    defineCustomProperties(schema: unknown): void;
  };
  getProvider(name: string): { getRegion(): string };
  service: {
    custom?: { signer?: RawSignerConfig };
    package?: { individually?: boolean; artifact?: string };
    functions?: Record<string, ServerlessFunction>;
    provider: { compiledCloudFormationTemplate?: { Resources?: Record<string, CfnResource> } };
    getServiceName(): string;
  };
}

interface PluginOptions {
  function?: string;
}

class ServerlessAwsCodeSigner {
  public hooks: Record<string, () => Promise<void>>;

  private readonly serverless: ServerlessLike;
  private readonly options: PluginOptions;
  private readonly provider: { getRegion(): string };
  private readonly log: Logger;

  private s3Client?: S3Client;
  private signerClient?: SignerClient;
  private profileArn?: { profileName: string; arn: string };
  private bucketsAsserted = false;

  constructor(
    serverless: ServerlessLike,
    options: PluginOptions = {},
    utils?: { log?: Partial<Logger> }
  ) {
    this.serverless = serverless;
    this.options = options;
    this.provider = serverless.getProvider('aws');

    // Serverless v3 passes a structured logger as the third argument; older
    // versions only have serverless.cli.log.
    const pluginLog = utils?.log;
    const cliLog = (message: string): void => {
      serverless.cli?.log(`[code-signer] ${message}`);
    };
    const noop = (): void => undefined;
    this.log = {
      notice: pluginLog?.notice ? (message): void => pluginLog.notice?.(message) : cliLog,
      info: pluginLog?.info ? (message): void => pluginLog.info?.(message) : cliLog,
      warning: pluginLog?.warning ? (message): void => pluginLog.warning?.(message) : cliLog,
      debug: pluginLog?.debug ? (message): void => pluginLog.debug?.(message) : noop,
    };

    serverless.configSchemaHandler.defineCustomProperties({
      type: 'object',
      properties: { signer: configSchema },
    });

    // Hooks are registered unconditionally and `enabled` is read inside them.
    // Deciding in the constructor would be wrong: it runs before Serverless has
    // finished resolving variables, and an unresolved "${...}" is truthy, so the
    // flag could not be trusted in either direction.
    this.hooks = {
      'after:package:createDeploymentArtifacts': () => this.signFunctions(),
      'after:deploy:function:packageFunction': () => this.signFunctions(),
      'before:package:finalize': () => this.attachCodeSigningConfig(),
    };
  }

  private get serviceDir(): string {
    return this.serverless.serviceDir ?? this.serverless.config?.servicePath ?? process.cwd();
  }

  private get s3(): S3Client {
    this.s3Client ??= new S3Client({ region: this.provider.getRegion() });
    return this.s3Client;
  }

  private get signer(): SignerClient {
    this.signerClient ??= new SignerClient({ region: this.provider.getRegion() });
    return this.signerClient;
  }

  private config(): ResolvedSignerConfig {
    return resolveSignerConfig(this.serverless.service.custom?.signer);
  }

  /**
   * Resolve the profile version ARN, once per profile per process.
   *
   * Both hooks need it, and the answer cannot change mid-deploy: pinning the
   * same version ARN in the template that was used to sign is the point.
   */
  private async resolveProfileVersionArn(profileName: string): Promise<string> {
    if (this.profileArn?.profileName === profileName) return this.profileArn.arn;
    const arn = await getActiveProfileVersionArn(this.signer, profileName);
    this.profileArn = { profileName, arn };
    return arn;
  }

  /**
   * Assert both buckets exist, once per process.
   *
   * Both the artifact loop and the custom-resource artifact need this, and the
   * answer cannot change mid-deploy.
   */
  private async assertBuckets(config: ResolvedSignerConfig): Promise<void> {
    if (this.bucketsAsserted) return;
    await assertBucketExists(this.s3, config.source.bucketName);
    if (config.destination.bucketName !== config.source.bucketName) {
      await assertBucketExists(this.s3, config.destination.bucketName);
    }
    this.bucketsAsserted = true;
  }

  private collectTargets(): SigningTarget[] {
    const service = this.serverless.service;
    const functions = service.functions ?? {};

    if (service.package?.individually !== true) {
      const artifact =
        service.package?.artifact ?? path.join('.serverless', `${service.getServiceName()}.zip`);
      return [
        {
          functionName: service.getServiceName(),
          artifactPath: path.resolve(this.serviceDir, artifact),
        },
      ];
    }

    const targets: SigningTarget[] = [];
    for (const [functionName, functionObject] of Object.entries(functions)) {
      if (this.options.function && this.options.function !== functionName) continue;
      if (functionObject.image) continue;

      const artifact = functionObject.package?.artifact;
      if (!artifact) {
        throw new SigningError(
          `Function "${functionName}" has no package artifact to sign. ` +
            'Signing runs after packaging; check that the packaging plugin produced a zip.'
        );
      }
      targets.push({ functionName, artifactPath: path.resolve(this.serviceDir, artifact) });
    }
    return targets;
  }

  private async signFunctions(): Promise<void> {
    const config = this.config();
    if (!config.enabled) {
      this.log.notice('Code signing is disabled for this stage; artifacts left unsigned.');
      return;
    }

    // Accepted by the schema so old configs still load, but it does nothing.
    // Only worth saying once signing is actually on -- warning about an ignored
    // option on a stage that never signs is pure noise.
    if (this.serverless.service.custom?.signer?.retain !== undefined) {
      this.log.warning(
        'custom.signer.retain is accepted but ignored: this plugin never creates ' +
          'signing profiles or buckets, so there is nothing to retain. It will be ' +
          'removed in a future major version; you can delete it now.'
      );
    }

    const targets = this.collectTargets();
    if (targets.length === 0) {
      this.log.warning('Code signing is enabled but no function artifacts were found to sign.');
      return;
    }

    // Validate the whole environment before touching any artifact, so a
    // misconfigured profile fails before half the functions are signed.
    const profileVersionArn = await this.resolveProfileVersionArn(config.profileName);
    await this.assertBuckets(config);

    this.log.notice(
      `Signing ${targets.length} artifact(s) with AWS Signer profile "${config.profileName}" ` +
        `(policy ${config.signingPolicy})`
    );
    this.log.info(`Signing profile version ARN: ${profileVersionArn}`);

    for (const target of targets) {
      await signArtifact({ s3: this.s3, signer: this.signer, log: this.log }, config, target);
    }
  }

  private async attachCodeSigningConfig(): Promise<void> {
    const config = this.config();
    if (!config.enabled) return;

    const resources = this.serverless.service.provider.compiledCloudFormationTemplate?.Resources;
    if (!resources) return;

    const profileVersionArn = await this.resolveProfileVersionArn(config.profileName);
    const userFunctionNames = new Set(
      Object.values(this.serverless.service.functions ?? {})
        .map((functionObject) => functionObject.name)
        .filter((name): name is string => typeof name === 'string')
    );

    // Sign the framework's artifact before anything points at the signing
    // config: attaching an Enforce policy to a function whose zip is unsigned
    // turns the deploy into a CloudFormation failure at CreateFunction time.
    const hasCustomResources = Object.values(resources).some(
      (resource) => resource.Type === 'AWS::Lambda::Function' && isFrameworkCustomResource(resource)
    );
    if (hasCustomResources && config.signCustomResources) {
      await this.signCustomResourceArtifact(config);
    }

    const attached = applyCodeSigningConfig(resources, {
      profileVersionArn,
      signingPolicy: config.signingPolicy,
      serviceName: this.serverless.service.getServiceName(),
      userFunctionNames,
      includeCustomResources: config.signCustomResources,
    });

    const custom =
      attached.customResourceFunctions > 0
        ? ` and ${attached.customResourceFunctions} Serverless-generated function(s)`
        : '';
    this.log.notice(
      `Attached CodeSigningConfig (${config.signingPolicy}) to ` +
        `${attached.userFunctions} function(s)${custom}`
    );
    this.log.info(`AllowedPublishers pins ${profileVersionArn}`);

    this.reportCoverageGaps(attached);
  }

  /**
   * Name every function in the template that is not covered by the signing
   * config, and why.
   *
   * If signing is on, the intent is that every function in the stack is signed.
   * Whatever this plugin cannot sign is therefore reported by name rather than
   * skipped quietly, so "is everything in this stack signed?" is answerable from
   * the deploy log instead of assumed.
   */
  private reportCoverageGaps(attached: ApplyResult): void {
    if (attached.skippedCustomResourceFunctions.length > 0) {
      this.log.warning(
        `${attached.skippedCustomResourceFunctions.length} Lambda(s) generated by Serverless ` +
          'will deploy UNSIGNED because `custom.signer.signCustomResources` is set to false: ' +
          `${attached.skippedCustomResourceFunctions.join(', ')}. ` +
          'Remove that setting to sign them.'
      );
    }

    if (attached.unsignableFunctions.length > 0) {
      this.log.warning(
        `${attached.unsignableFunctions.length} Lambda(s) in this stack are NOT signed and ` +
          'cannot be by this plugin, because another plugin injected them and their ' +
          `artifacts are not ours to locate: ${attached.unsignableFunctions.join(', ')}. ` +
          'Sign them at their source, or accept them as out of scope.'
      );
    }

    if (attached.imageFunctions.length > 0) {
      this.log.notice(
        `${attached.imageFunctions.length} container-image function(s) carry no code-signing ` +
          `config: ${attached.imageFunctions.join(', ')}. ` +
          'AWS Signer does not cover images -- that is ECR image signing, a separate mechanism.'
      );
    }
  }

  /**
   * Sign the shared artifact behind the framework's custom-resource Lambdas.
   *
   * Safe to do here, and only here. The zip does not exist at
   * `after:package:createDeploymentArtifacts` -- Serverless writes it during
   * `package:compileEvents` -- and it is read back off disk at `deploy:deploy`,
   * so `before:package:finalize` is the one window where it is both present and
   * not yet uploaded.
   *
   * Unlike the function artifacts, no `AWS::Lambda::Version` hashes this zip, so
   * signing it after `package:compileFunctions` carries no CodeSha256 risk. The
   * file is also a plain copy of the framework's global cache in
   * `~/.serverless/artifacts/`, so overwriting it here cannot poison that cache
   * for other services.
   */
  private async signCustomResourceArtifact(config: ResolvedSignerConfig): Promise<void> {
    const artifactPath = path.resolve(
      this.serviceDir,
      '.serverless',
      CUSTOM_RESOURCE_ARTIFACT_NAME
    );

    try {
      await fsp.access(artifactPath);
    } catch {
      throw new SigningError(
        `The template contains Serverless-generated custom-resource Lambdas but ` +
          `${artifactPath} does not exist, so it cannot be signed. Refusing to attach an ` +
          'Enforce code-signing policy to a function whose artifact was never signed.'
      );
    }

    await this.resolveProfileVersionArn(config.profileName);
    await this.assertBuckets(config);

    this.log.notice('Signing the Serverless-generated custom-resource artifact');
    await signArtifact({ s3: this.s3, signer: this.signer, log: this.log }, config, {
      functionName: 'custom-resources',
      artifactPath,
    });
  }
}

export = ServerlessAwsCodeSigner;
