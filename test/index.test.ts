import { mockClient } from 'aws-sdk-client-mock';
import { GetSigningProfileCommand, SignerClient } from '@aws-sdk/client-signer';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CfnResource } from '../src/cloudformation';
import Plugin from '../src/index';

const signerMock = mockClient(SignerClient);
const s3Mock = mockClient(S3Client);

const PROFILE_ARN = 'arn:aws:signer:us-east-1:1234:/signing-profiles/my-profile/ABC';

interface Overrides {
  retain?: unknown;
  functions?: Record<string, { name?: string; image?: unknown; package?: { artifact?: string } }>;
}

const build = (overrides: Overrides = {}) => {
  const log = { info: vi.fn(), warning: vi.fn(), debug: vi.fn() };
  const serverless = {
    serviceDir: '/tmp/svc',
    configSchemaHandler: { defineCustomProperties: vi.fn() },
    getProvider: () => ({ getRegion: () => 'us-east-1' }),
    service: {
      custom: {
        signer: {
          profileName: 'my-profile',
          source: { s3: { bucketName: 'bucket' } },
          ...(overrides.retain !== undefined ? { retain: overrides.retain } : {}),
        },
      },
      // No `package.individually`, so there is a single service artifact and
      // collectTargets does not need per-function package.artifact entries.
      package: {},
      functions: overrides.functions ?? {},
      provider: {
        compiledCloudFormationTemplate: {
          Resources: {} as Record<string, CfnResource>,
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
