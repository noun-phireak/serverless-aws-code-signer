export type SigningPolicy = 'Enforce' | 'Warn';

/** Config exactly as it appears under `custom.signer` in serverless.yml. */
export interface RawSignerConfig {
  enabled?: unknown;
  profileName?: unknown;
  signingPolicy?: unknown;
  timeoutSeconds?: unknown;
  signCustomResources?: unknown;
  source?: { s3?: { bucketName?: unknown; prefix?: unknown } };
  destination?: { s3?: { bucketName?: unknown; prefix?: unknown } };
  /**
   * Accepted for compatibility with configs carried over from other signing
   * plugins, and deliberately ignored: this plugin never creates or revokes
   * signing profiles or buckets, so there is nothing for it to retain.
   */
  retain?: unknown;
}

export interface ResolvedSignerConfig {
  enabled: boolean;
  profileName: string;
  signingPolicy: SigningPolicy;
  timeoutSeconds: number;
  signCustomResources: boolean;
  source: { bucketName: string; prefix: string };
  destination: { bucketName: string; prefix: string };
}

export interface SigningTarget {
  functionName: string;
  artifactPath: string;
}

export interface Logger {
  /**
   * Serverless log levels are ordered error > warning > notice > info > debug,
   * and the default threshold is `notice` -- `info` and below are only shown
   * under `--verbose`. Anything that answers "did this deploy get signed, and
   * with what?" must therefore be `notice`, not `info`, or it is invisible in
   * exactly the CI log where the answer matters.
   */
  notice(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  debug(message: string): void;
}
