import path from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { SignerClient } from '@aws-sdk/client-signer';

import { applyCodeSigningConfig, type CfnResource } from './cloudformation';
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
      this.log.info('Code signing is disabled for this stage; artifacts left unsigned.');
      return;
    }

    const targets = this.collectTargets();
    if (targets.length === 0) {
      this.log.info('No function artifacts to sign.');
      return;
    }

    // Validate the whole environment before touching any artifact, so a
    // misconfigured profile fails before half the functions are signed.
    await getActiveProfileVersionArn(this.signer, config.profileName);
    await assertBucketExists(this.s3, config.source.bucketName);
    if (config.destination.bucketName !== config.source.bucketName) {
      await assertBucketExists(this.s3, config.destination.bucketName);
    }

    this.log.info(
      `Signing ${targets.length} artifact(s) with profile "${config.profileName}" ` +
        `(policy ${config.signingPolicy})`
    );

    for (const target of targets) {
      await signArtifact({ s3: this.s3, signer: this.signer, log: this.log }, config, target);
    }
  }

  private async attachCodeSigningConfig(): Promise<void> {
    const config = this.config();
    if (!config.enabled) return;

    const resources = this.serverless.service.provider.compiledCloudFormationTemplate?.Resources;
    if (!resources) return;

    const profileVersionArn = await getActiveProfileVersionArn(this.signer, config.profileName);
    const userFunctionNames = new Set(
      Object.values(this.serverless.service.functions ?? {})
        .map((functionObject) => functionObject.name)
        .filter((name): name is string => typeof name === 'string')
    );

    applyCodeSigningConfig(resources, {
      profileVersionArn,
      signingPolicy: config.signingPolicy,
      serviceName: this.serverless.service.getServiceName(),
      userFunctionNames,
    });
  }
}

export = ServerlessAwsCodeSigner;
