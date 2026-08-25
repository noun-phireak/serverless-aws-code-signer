export type SigningPolicy = 'Enforce' | 'Warn';

/** Config exactly as it appears under `custom.signer` in serverless.yml. */
export interface RawSignerConfig {
  enabled?: unknown;
  profileName?: unknown;
  signingPolicy?: unknown;
  timeoutSeconds?: unknown;
  source?: { s3?: { bucketName?: unknown; prefix?: unknown } };
  destination?: { s3?: { bucketName?: unknown; prefix?: unknown } };
  /**
   * Accepted for drop-in compatibility with @ioiotv/serverless-aws-signer and
   * deliberately ignored: this plugin never creates or revokes signing profiles
   * or buckets, so there is nothing for it to retain.
   */
  retain?: unknown;
}

export interface ResolvedSignerConfig {
  enabled: boolean;
  profileName: string;
  signingPolicy: SigningPolicy;
  timeoutSeconds: number;
  source: { bucketName: string; prefix: string };
  destination: { bucketName: string; prefix: string };
}

export interface SigningTarget {
  functionName: string;
  artifactPath: string;
}

export interface Logger {
  info(message: string): void;
  warning(message: string): void;
  debug(message: string): void;
}
