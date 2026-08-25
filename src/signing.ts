import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  DescribeSigningJobCommand,
  GetSigningProfileCommand,
  StartSigningJobCommand,
  type SignerClient,
} from '@aws-sdk/client-signer';

import type { Logger, ResolvedSignerConfig, SigningTarget } from './types';

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

export interface SigningClients {
  s3: S3Client;
  signer: SignerClient;
  log: Logger;
}

const POLL_INITIAL_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('base64');

/**
 * Look up the signing profile.
 *
 * This never creates a missing profile: a typo in `profileName` must fail the
 * deploy, not mint a fresh unreviewed profile that happens to satisfy the
 * config.
 */
export async function getActiveProfileVersionArn(
  signer: SignerClient,
  profileName: string
): Promise<string> {
  let profile;
  try {
    profile = await signer.send(new GetSigningProfileCommand({ profileName }));
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'ResourceNotFoundException' || name === 'ProfileNotFound') {
      throw new SigningError(
        `Signing profile "${profileName}" does not exist in this account/region. ` +
          'Create it out-of-band (Terraform/SRE) and re-run -- this plugin will not create it.'
      );
    }
    throw error;
  }

  if (profile.status !== undefined && profile.status !== 'Active') {
    throw new SigningError(
      `Signing profile "${profileName}" is ${profile.status}, not Active. Refusing to sign.`
    );
  }
  if (!profile.profileVersionArn) {
    throw new SigningError(
      `Signing profile "${profileName}" returned no profileVersionArn. Refusing to sign.`
    );
  }
  return profile.profileVersionArn;
}

/** Assert a bucket exists. Never creates one -- see the note on profiles. */
export async function assertBucketExists(s3: S3Client, bucketName: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'NotFound' || name === 'NoSuchBucket') {
      throw new SigningError(
        `S3 bucket "${bucketName}" does not exist. Create it out-of-band and re-run -- ` +
          'this plugin will not create it.'
      );
    }
    if (name === 'Forbidden') {
      throw new SigningError(
        `No permission to access S3 bucket "${bucketName}". Check the deploy role's s3 permissions.`
      );
    }
    throw error;
  }
}

async function waitForSigningJob(
  signer: SignerClient,
  jobId: string,
  timeoutSeconds: number,
  log: Logger
): Promise<{ bucketName: string; key: string }> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let delayMs = POLL_INITIAL_DELAY_MS;

  for (;;) {
    const job = await signer.send(new DescribeSigningJobCommand({ jobId }));

    if (job.status === 'Succeeded') {
      const signed = job.signedObject?.s3;
      if (!signed?.bucketName || !signed.key) {
        throw new SigningError(
          `Signing job ${jobId} succeeded but returned no signed object location.`
        );
      }
      return { bucketName: signed.bucketName, key: signed.key };
    }

    if (job.status === 'Failed') {
      throw new SigningError(
        `Signing job ${jobId} failed: ${job.statusReason ?? 'no reason given'}`
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new SigningError(
        `Signing job ${jobId} did not finish within ${timeoutSeconds}s ` +
          `(last status: ${job.status ?? 'unknown'}).`
      );
    }

    log.debug(`Signing job ${jobId} is ${job.status ?? 'InProgress'}, waiting ${delayMs}ms`);
    await sleep(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, POLL_MAX_DELAY_MS);
  }
}

/**
 * Stage one artifact in S3, sign it, and replace the local zip with the signed
 * bytes.
 *
 * The write is `fsp.writeFile` and is genuinely awaited. Callback-style
 * `fs.writeFile` with no callback is a trap here: because Serverless
 * gracefulify's `fs`, it returns immediately with the zip truncated to zero
 * bytes, and `package:compileFunctions` then hashes the empty file into
 * `AWS::Lambda::Version.CodeSha256` while the complete artifact is what
 * actually gets uploaded.
 */
export async function signArtifact(
  clients: SigningClients,
  config: ResolvedSignerConfig,
  target: SigningTarget
): Promise<void> {
  const { s3, signer, log } = clients;
  const artifactName = path.basename(target.artifactPath);
  const localBytes = await fsp.readFile(target.artifactPath);

  if (localBytes.length === 0) {
    throw new SigningError(
      `Artifact ${target.artifactPath} is empty before signing. Refusing to sign a zero-byte zip.`
    );
  }

  const stagingKey = `${config.source.prefix}${target.functionName}-${Date.now()}-${randomUUID()}`;
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: config.source.bucketName,
      Key: stagingKey,
      Body: localBytes,
    })
  );

  if (!put.VersionId) {
    throw new SigningError(
      `S3 bucket "${config.source.bucketName}" returned no VersionId. AWS Signer requires a ` +
        'versioned source bucket; enable versioning on it.'
    );
  }

  const started = await signer.send(
    new StartSigningJobCommand({
      profileName: config.profileName,
      clientRequestToken: randomUUID(),
      source: {
        s3: { bucketName: config.source.bucketName, key: stagingKey, version: put.VersionId },
      },
      destination: {
        s3: { bucketName: config.destination.bucketName, prefix: config.destination.prefix },
      },
    })
  );

  if (!started.jobId) {
    throw new SigningError(`StartSigningJob returned no jobId for ${target.functionName}.`);
  }

  const signedLocation = await waitForSigningJob(
    signer,
    started.jobId,
    config.timeoutSeconds,
    log
  );

  const signedObject = await s3.send(
    new GetObjectCommand({ Bucket: signedLocation.bucketName, Key: signedLocation.key })
  );
  if (!signedObject.Body) {
    throw new SigningError(`Signed object ${signedLocation.key} had no body.`);
  }

  const signedBytes = await signedObject.Body.transformToByteArray();
  if (signedBytes.length === 0) {
    throw new SigningError(`Signed object ${signedLocation.key} is empty. Refusing to ship it.`);
  }

  await fsp.writeFile(target.artifactPath, signedBytes);

  // Read the size back off disk. This assertion turns a truncated write into a
  // failed deploy rather than a CodeSha256 mismatch inside CloudFormation.
  const written = await fsp.stat(target.artifactPath);
  if (written.size !== signedBytes.length) {
    throw new SigningError(
      `Wrote ${signedBytes.length} bytes of signed artifact to ${target.artifactPath} ` +
        `but the file is ${written.size} bytes.`
    );
  }

  log.info(
    `Signed ${artifactName} (${signedBytes.length} bytes, ` +
      `CodeSha256 ${sha256Base64(signedBytes)}, job ${started.jobId})`
  );
}
