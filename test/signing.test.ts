import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DescribeSigningJobCommand,
  GetSigningProfileCommand,
  SignerClient,
  StartSigningJobCommand,
} from '@aws-sdk/client-signer';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertBucketExists,
  getActiveProfileVersionArn,
  signArtifact,
  SigningError,
} from '../src/signing';
import type { Logger, ResolvedSignerConfig } from '../src/types';

const s3Mock = mockClient(S3Client);
const signerMock = mockClient(SignerClient);

const silentLog: Logger = { info: () => undefined, warning: () => undefined, debug: () => undefined };

const config: ResolvedSignerConfig = {
  enabled: true,
  profileName: 'my-profile',
  signingPolicy: 'Enforce',
  timeoutSeconds: 5,
  source: { bucketName: 'artifacts', prefix: 'staging/' },
  destination: { bucketName: 'artifacts', prefix: 'signed/' },
};

/** sha256 of zero bytes -- the value CloudFormation reported in the outage. */
const EMPTY_FILE_SHA256 = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
let tmpDir: string;
let artifactPath: string;

const clients = (): { s3: S3Client; signer: SignerClient; log: Logger } => ({
  s3: new S3Client({ region: 'us-east-1' }),
  signer: new SignerClient({ region: 'us-east-1' }),
  log: silentLog,
});

/** Wire up the happy path: put -> start -> succeed -> get signed bytes. */
const stubSuccessfulSigning = (signedBytes: Buffer): void => {
  s3Mock.on(PutObjectCommand).resolves({ VersionId: 'version-1' });
  signerMock.on(StartSigningJobCommand).resolves({ jobId: 'job-1' });
  signerMock.on(DescribeSigningJobCommand).resolves({
    status: 'Succeeded',
    signedObject: { s3: { bucketName: 'artifacts', key: 'signed/job-1' } },
  });
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToByteArray: async () => new Uint8Array(signedBytes) },
  } as never);
};

beforeEach(async () => {
  s3Mock.reset();
  signerMock.reset();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-signer-'));
  artifactPath = path.join(tmpDir, 'my-function.zip');
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('getActiveProfileVersionArn', () => {
  it('returns the profile version arn', async () => {
    signerMock.on(GetSigningProfileCommand).resolves({
      status: 'Active',
      profileVersionArn: 'arn:aws:signer:us-east-1:1234:/signing-profiles/my-profile/ABC',
    });
    await expect(getActiveProfileVersionArn(new SignerClient({}), 'my-profile')).resolves.toContain(
      'signing-profiles/my-profile'
    );
  });

  // The vendor plugin called createSigningProfile() here, so a typo in
  // profileName silently produced a brand new, unreviewed signing profile.
  it('fails instead of creating a missing profile', async () => {
    const notFound = Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
    signerMock.on(GetSigningProfileCommand).rejects(notFound);

    await expect(getActiveProfileVersionArn(new SignerClient({}), 'typo')).rejects.toThrow(
      /will not create it/
    );
  });

  it('refuses to sign with a revoked profile', async () => {
    signerMock.on(GetSigningProfileCommand).resolves({
      status: 'Revoked',
      profileVersionArn: 'arn:aws:signer:us-east-1:1234:/signing-profiles/my-profile/ABC',
    });
    await expect(getActiveProfileVersionArn(new SignerClient({}), 'my-profile')).rejects.toThrow(
      /is Revoked, not Active/
    );
  });
});

describe('assertBucketExists', () => {
  it('fails instead of creating a missing bucket', async () => {
    s3Mock.on(HeadBucketCommand).rejects(Object.assign(new Error('nope'), { name: 'NotFound' }));
    await expect(assertBucketExists(new S3Client({}), 'gone')).rejects.toThrow(/will not create it/);
  });
});

describe('signArtifact', () => {
  it('leaves the complete signed artifact on disk once it resolves', async () => {
    const signedBytes = Buffer.alloc(5 * 1024 * 1024, 7);
    await fsp.writeFile(artifactPath, Buffer.alloc(1024, 1));
    stubSuccessfulSigning(signedBytes);

    await signArtifact(clients(), config, { functionName: 'myFunction', artifactPath });

    // This is the regression test for the bug that broke deploys: the vendor
    // plugin used the callback-style fs.writeFile with no callback, which under
    // graceful-fs returned immediately with the zip truncated to zero bytes.
    // Serverless then hashed the empty file into AWS::Lambda::Version.CodeSha256
    // while the complete artifact was what got uploaded, and CloudFormation
    // rejected the mismatch.
    const onDisk = await fsp.readFile(artifactPath);
    expect(onDisk.length).toBe(signedBytes.length);
    expect(onDisk.equals(signedBytes)).toBe(true);

    const sha = createHash('sha256').update(onDisk).digest('base64');
    expect(sha).not.toBe(EMPTY_FILE_SHA256);
  });

  it('refuses to sign a zero-byte artifact', async () => {
    await fsp.writeFile(artifactPath, Buffer.alloc(0));
    stubSuccessfulSigning(Buffer.alloc(10, 1));

    await expect(
      signArtifact(clients(), config, { functionName: 'myFunction', artifactPath })
    ).rejects.toThrow(/zero-byte zip/);
  });

  it('refuses to ship an empty signed object', async () => {
    await fsp.writeFile(artifactPath, Buffer.alloc(1024, 1));
    stubSuccessfulSigning(Buffer.alloc(0));

    await expect(
      signArtifact(clients(), config, { functionName: 'myFunction', artifactPath })
    ).rejects.toThrow(/is empty. Refusing to ship it/);
  });

  it('fails when the source bucket is not versioned', async () => {
    await fsp.writeFile(artifactPath, Buffer.alloc(1024, 1));
    s3Mock.on(PutObjectCommand).resolves({});

    await expect(
      signArtifact(clients(), config, { functionName: 'myFunction', artifactPath })
    ).rejects.toThrow(/versioned source bucket/);
  });

  it('surfaces a failed signing job', async () => {
    await fsp.writeFile(artifactPath, Buffer.alloc(1024, 1));
    s3Mock.on(PutObjectCommand).resolves({ VersionId: 'version-1' });
    signerMock.on(StartSigningJobCommand).resolves({ jobId: 'job-1' });
    signerMock
      .on(DescribeSigningJobCommand)
      .resolves({ status: 'Failed', statusReason: 'unsupported format' });

    await expect(
      signArtifact(clients(), config, { functionName: 'myFunction', artifactPath })
    ).rejects.toThrow(/unsupported format/);
  });

  // The vendor plugin polled describeSigningJob in a while loop with no delay
  // and no timeout, so a stuck job spun forever against the Signer API.
  it('gives up on a job that never finishes', async () => {
    await fsp.writeFile(artifactPath, Buffer.alloc(1024, 1));
    s3Mock.on(PutObjectCommand).resolves({ VersionId: 'version-1' });
    signerMock.on(StartSigningJobCommand).resolves({ jobId: 'job-1' });
    signerMock.on(DescribeSigningJobCommand).resolves({ status: 'InProgress' });

    await expect(
      signArtifact(clients(), { ...config, timeoutSeconds: 0.2 }, {
        functionName: 'myFunction',
        artifactPath,
      })
    ).rejects.toThrow(SigningError);
  });
});
