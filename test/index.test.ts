import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mockClient } from 'aws-sdk-client-mock';
import {
  DescribeSigningJobCommand,
  GetSigningProfileCommand,
  SignerClient,
  StartSigningJobCommand,
} from '@aws-sdk/client-signer';
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CfnResource } from '../src/cloudformation';
import Plugin from '../src/index';

const signerMock = mockClient(SignerClient);
const s3Mock = mockClient(S3Client);

const PROFILE_ARN = 'arn:aws:signer:us-east-1:1234:/signing-profiles/my-profile/ABC';

interface Overrides {
  individually?: boolean;
  retain?: unknown;
  enabled?: unknown;
  signCustomResources?: unknown;
  serviceDir?: string;
  resources?: Record<string, CfnResource>;
  functions?: Record<string, { name?: string; image?: unknown; package?: { artifact?: string } }>;
}

/** The Lambda Serverless injects for an `existing: true` S3 event. */
const customResourceFunction = (): CfnResource => ({
  Type: 'AWS::Lambda::Function',
  Properties: {
    FunctionName: 'svc-dev-custom-resource-existing-s3',
    Code: { S3Bucket: 'deploy', S3Key: 'serverless/svc/dev/1234-abc/custom-resources.zip' },
  },
});

const build = (overrides: Overrides = {}) => {
  const log = { notice: vi.fn(), info: vi.fn(), warning: vi.fn(), debug: vi.fn() };
  const serverless = {
    serviceDir: overrides.serviceDir ?? '/tmp/svc',
    configSchemaHandler: { defineCustomProperties: vi.fn() },
    getProvider: () => ({ getRegion: () => 'us-east-1' }),
    service: {
      custom: {
        signer: {
          profileName: 'my-profile',
          source: { s3: { bucketName: 'bucket' } },
          ...(overrides.retain !== undefined ? { retain: overrides.retain } : {}),
          ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
          ...(overrides.signCustomResources !== undefined
            ? { signCustomResources: overrides.signCustomResources }
            : {}),
        },
      },
      // Without `package.individually` there is a single service artifact and
      // collectTargets does not need per-function package.artifact entries.
      package: { individually: overrides.individually },
      functions: overrides.functions ?? {},
      provider: {
        compiledCloudFormationTemplate: {
          Resources: (overrides.resources ?? {}) as Record<string, CfnResource>,
        },
      },
      getServiceName: () => 'svc',
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = new (Plugin as any)(serverless, {}, { log });
  return { plugin, serverless, log };
};

beforeEach(() => {
  signerMock.reset();
  s3Mock.reset();
  signerMock.on(GetSigningProfileCommand).resolves({
    status: 'Active',
    profileVersionArn: PROFILE_ARN,
  });
  s3Mock.on(HeadBucketCommand).resolves({});
});

describe('retain', () => {
  it('warns that retain is ignored when it is present', async () => {
    const { plugin, log } = build({ retain: true });
    // Signing itself will fail (no artifact on disk); the warning is emitted
    // before any of that, which is what this asserts.
    await plugin.signFunctions().catch(() => undefined);

    const warned = log.warning.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(warned).toMatch(/retain is accepted but ignored/);
  });

  it('stays silent when signing is disabled for the stage', async () => {
    const { plugin, log } = build({ retain: true, enabled: false });
    await plugin.signFunctions();

    // Warning about an ignored option on a stage that never signs is noise.
    const warned = log.warning.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(warned).not.toMatch(/retain/);
    expect(log.notice.mock.calls.flat().join('\n')).toMatch(/disabled for this stage/);
  });

  it('says nothing when retain is absent', async () => {
    const { plugin, log } = build();
    await plugin.signFunctions().catch(() => undefined);

    const warned = log.warning.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(warned).not.toMatch(/retain/);
  });
});

describe('profile version ARN', () => {
  it('is fetched once and reused across both hooks', async () => {
    const { plugin } = build();

    await plugin.signFunctions().catch(() => undefined);
    await plugin.attachCodeSigningConfig();

    // Previously each hook called GetSigningProfile independently, so a deploy
    // hit Signer twice for an answer that cannot change mid-deploy.
    expect(signerMock.commandCalls(GetSigningProfileCommand)).toHaveLength(1);
  });

  it('still pins the resolved ARN into the template', async () => {
    const { plugin, serverless } = build();
    await plugin.attachCodeSigningConfig();

    const resources = serverless.service.provider.compiledCloudFormationTemplate.Resources;
    expect(resources.CodeSigningConfig?.Properties).toMatchObject({
      AllowedPublishers: { SigningProfileVersionArns: [PROFILE_ARN] },
    });
  });
});

/**
 * Serverless log levels are error > warning > notice > info > debug, and the
 * default threshold is `notice`: `log.info` is invisible without --verbose.
 * These messages are the deploy's only evidence that signing happened, and a
 * CI log is exactly where that evidence is read, so they must not sink back
 * below `notice`.
 */
describe('log visibility at default verbosity', () => {
  it('announces on notice that signing is starting', async () => {
    const { plugin, log } = build({
      functions: { alpha: { name: 'svc-alpha' } },
    });
    await plugin.signFunctions().catch(() => undefined);

    const noticed = log.notice.mock.calls.flat().join('\n');
    expect(noticed).toMatch(/Signing 1 artifact\(s\) with AWS Signer profile "my-profile"/);
    expect(noticed).toMatch(/policy Enforce/);
  });

  it('announces on notice that a stage is deliberately unsigned', async () => {
    const { plugin, log } = build({ enabled: false });
    await plugin.signFunctions();

    expect(log.notice.mock.calls.flat().join('\n')).toMatch(/disabled for this stage/);
  });

  it('announces on notice that the CodeSigningConfig was attached', async () => {
    const { plugin, log } = build({ functions: { alpha: { name: 'svc-alpha' } } });
    await plugin.attachCodeSigningConfig();

    expect(log.notice.mock.calls.flat().join('\n')).toMatch(
      /Attached CodeSigningConfig \(Enforce\) to \d+ function\(s\)/
    );
  });

  it('warns rather than staying silent when there is nothing to sign', async () => {
    const { plugin, log } = build({ individually: true, functions: {} });
    await plugin.signFunctions();

    expect(log.warning.mock.calls.flat().join('\n')).toMatch(/no function artifacts were found/);
  });
});

/**
 * `existing: true` S3 events (and EventBridge, Cognito user pools, the API
 * Gateway CloudWatch role) make Serverless inject its own Lambdas during
 * `package:compileEvents` -- after signFunctions has already run. They share one
 * artifact, `.serverless/custom-resources.zip`, which does not exist until that
 * point and is read back off disk at `deploy:deploy`.
 */
describe('framework custom-resource Lambdas', () => {
  let serviceDir: string;
  let artifactPath: string;

  beforeEach(async () => {
    serviceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-signer-cr-'));
    artifactPath = path.join(serviceDir, '.serverless', 'custom-resources.zip');
    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(serviceDir, { recursive: true, force: true });
  });

  const stubSigning = (signedBytes: Buffer): void => {
    s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v1' });
    signerMock.on(StartSigningJobCommand).resolves({ jobId: 'job-cr' });
    signerMock.on(DescribeSigningJobCommand).resolves({
      status: 'Succeeded',
      signedObject: { s3: { bucketName: 'bucket', key: 'signed/custom-resources.zip' } },
    });
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array(signedBytes) },
    } as never);
  };

  it('signs the shared artifact and attaches the config, with no opt-in needed', async () => {
    const signedBytes = Buffer.alloc(4096, 9);
    await fsp.writeFile(artifactPath, Buffer.alloc(2048, 1));
    stubSigning(signedBytes);

    const resources = { CustomS3: customResourceFunction() };
    const { plugin, log } = build({ serviceDir, resources });
    await plugin.attachCodeSigningConfig();

    // The signed bytes must be on disk before deploy:deploy uploads the file.
    const onDisk = await fsp.readFile(artifactPath);
    expect(onDisk.equals(signedBytes)).toBe(true);

    expect(resources.CustomS3.Properties?.CodeSigningConfigArn).toEqual({
      Ref: 'CodeSigningConfig',
    });
    expect(log.warning.mock.calls.flat().join('\n')).not.toMatch(/UNSIGNED/);
    expect(log.notice.mock.calls.flat().join('\n')).toMatch(
      /Serverless-generated function\(s\)/
    );
  });

  it('names them in a warning when they are explicitly opted out', async () => {
    const resources = { CustomS3: customResourceFunction() };
    const { plugin, log } = build({ signCustomResources: false, serviceDir, resources });
    await plugin.attachCodeSigningConfig();

    expect(resources.CustomS3.Properties).not.toHaveProperty('CodeSigningConfigArn');
    const warned = log.warning.mock.calls.flat().join('\n');
    expect(warned).toMatch(/will deploy UNSIGNED/);
    expect(warned).toMatch(/svc-dev-custom-resource-existing-s3/);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('accepts the opt-out as a serverless-resolved string', async () => {
    const resources = { CustomS3: customResourceFunction() };
    const { plugin } = build({ signCustomResources: 'false', serviceDir, resources });
    await plugin.attachCodeSigningConfig();

    expect(resources.CustomS3.Properties).not.toHaveProperty('CodeSigningConfigArn');
  });

  it('fails rather than attaching Enforce when the artifact is missing', async () => {
    const { plugin } = build({
      serviceDir,
      resources: { CustomS3: customResourceFunction() },
    });

    await expect(plugin.attachCodeSigningConfig()).rejects.toThrow(/does not exist/);
  });

  it('does nothing when the template has no custom resources', async () => {
    const { plugin, log } = build({ serviceDir });
    await plugin.attachCodeSigningConfig();

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(log.warning.mock.calls.flat().join('\n')).not.toMatch(/UNSIGNED/);
  });
});

/**
 * The user's rule: if signing is on, every function in the stack should be
 * signed. Whatever this plugin cannot sign is named in the log rather than
 * skipped quietly, so the claim is verifiable instead of assumed.
 */
describe('coverage gaps are reported, not hidden', () => {
  it('warns by name about Lambdas other plugins injected', async () => {
    const { plugin, log } = build({
      resources: {
        WarmerLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'svc-warmup-plugin',
            Code: { S3Bucket: 'deploy', S3Key: 'serverless/svc/dev/1/warmup.zip' },
          },
        },
      },
    });
    await plugin.attachCodeSigningConfig();

    const warned = log.warning.mock.calls.flat().join('\n');
    expect(warned).toMatch(/are NOT signed and cannot be/);
    expect(warned).toMatch(/svc-warmup-plugin/);
  });

  it('says on notice that container images carry no signing config', async () => {
    const { plugin, log } = build({
      functions: { img: { name: 'svc-img' } },
      resources: {
        ImgLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-img', PackageType: 'Image' },
        },
      },
    });
    await plugin.attachCodeSigningConfig();

    const noticed = log.notice.mock.calls.flat().join('\n');
    expect(noticed).toMatch(/container-image function\(s\) carry no code-signing config/);
    expect(noticed).toMatch(/svc-img/);
  });

  it('stays quiet when every function is covered', async () => {
    const { plugin, log } = build({
      functions: { alpha: { name: 'svc-alpha' } },
      resources: {
        AlphaLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-alpha' },
        },
      },
    });
    await plugin.attachCodeSigningConfig();

    expect(log.warning.mock.calls).toHaveLength(0);
  });
});
