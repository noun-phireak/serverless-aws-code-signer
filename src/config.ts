import type { RawSignerConfig, ResolvedSignerConfig, SigningPolicy } from './types';

const UNRESOLVED_VARIABLE = /\$\{/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const SIGNING_POLICIES: SigningPolicy[] = ['Enforce', 'Warn'];

export class SignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerConfigError';
  }
}

/**
 * Decide whether signing runs.
 *
 * This is deliberately strict. An unresolved `${...}` is a hard error rather
 * than a truthy string, because a signing plugin that cannot tell whether it is
 * meant to run must never quietly pick an answer -- guessing "on" ships an
 * unwanted signature, guessing "off" ships unsigned code.
 */
export function parseEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (UNRESOLVED_VARIABLE.test(value)) {
      throw new SignerConfigError(
        `custom.signer.enabled is still an unresolved variable ("${value}"). ` +
          'Refusing to guess whether code signing should run. Check that the ' +
          'variable resolves for this stage before deploying.'
      );
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  throw new SignerConfigError(
    'custom.signer.enabled must be a boolean (or the string "true"/"false"), ' +
      `received ${JSON.stringify(value)}.`
  );
}

function requireResolvedString(value: unknown, propertyPath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SignerConfigError(`${propertyPath} is required and must be a non-empty string.`);
  }
  if (UNRESOLVED_VARIABLE.test(value)) {
    throw new SignerConfigError(
      `${propertyPath} is still an unresolved variable ("${value}"). ` +
        'Check that the variable resolves for this stage before deploying.'
    );
  }
  return value;
}

function optionalResolvedString(value: unknown, propertyPath: string): string {
  if (value === undefined || value === null) return '';
  return requireResolvedString(value, propertyPath);
}

function parseSigningPolicy(value: unknown): SigningPolicy {
  if (value === undefined || value === null) return 'Enforce';
  if (SIGNING_POLICIES.includes(value as SigningPolicy)) return value as SigningPolicy;
  throw new SignerConfigError(
    `custom.signer.signingPolicy must be one of ${SIGNING_POLICIES.join(', ')}, ` +
      `received ${JSON.stringify(value)}.`
  );
}

function parseTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_SECONDS;
  const timeout = typeof value === 'string' ? Number(value) : value;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new SignerConfigError(
      `custom.signer.timeoutSeconds must be a positive number, received ${JSON.stringify(value)}.`
    );
  }
  return timeout;
}

/**
 * Resolve `custom.signer` into a fully-checked config.
 *
 * Called from inside the lifecycle hooks rather than the plugin constructor, so
 * that Serverless has finished resolving variables by the time it runs.
 */
export function resolveSignerConfig(raw: RawSignerConfig | undefined): ResolvedSignerConfig {
  if (raw === undefined || raw === null) {
    throw new SignerConfigError(
      'serverless-aws-code-signer is listed in `plugins` but `custom.signer` is missing. ' +
        'Configure it, or remove the plugin -- it will not silently skip signing.'
    );
  }

  const enabled = parseEnabled(raw.enabled);
  if (!enabled) {
    return {
      enabled: false,
      profileName: '',
      signingPolicy: 'Enforce',
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      source: { bucketName: '', prefix: '' },
      destination: { bucketName: '', prefix: '' },
    };
  }

  const sourceBucket = requireResolvedString(
    raw.source?.s3?.bucketName,
    'custom.signer.source.s3.bucketName'
  );
  const destinationBucket =
    raw.destination?.s3?.bucketName === undefined
      ? sourceBucket
      : requireResolvedString(raw.destination.s3.bucketName, 'custom.signer.destination.s3.bucketName');

  return {
    enabled: true,
    profileName: requireResolvedString(raw.profileName, 'custom.signer.profileName'),
    signingPolicy: parseSigningPolicy(raw.signingPolicy),
    timeoutSeconds: parseTimeoutSeconds(raw.timeoutSeconds),
    source: {
      bucketName: sourceBucket,
      prefix: optionalResolvedString(raw.source?.s3?.prefix, 'custom.signer.source.s3.prefix'),
    },
    destination: {
      bucketName: destinationBucket,
      prefix: optionalResolvedString(
        raw.destination?.s3?.prefix,
        'custom.signer.destination.s3.prefix'
      ),
    },
  };
}

export const configSchema = {
  type: 'object',
  properties: {
    enabled: { type: ['boolean', 'string'] },
    profileName: { type: 'string' },
    signingPolicy: { enum: SIGNING_POLICIES },
    timeoutSeconds: { type: 'number' },
    retain: { type: 'boolean' },
    source: {
      type: 'object',
      properties: {
        s3: {
          type: 'object',
          properties: { bucketName: { type: 'string' }, prefix: { type: 'string' } },
          required: ['bucketName'],
        },
      },
    },
    destination: {
      type: 'object',
      properties: {
        s3: {
          type: 'object',
          properties: { bucketName: { type: 'string' }, prefix: { type: 'string' } },
        },
      },
    },
  },
  additionalProperties: false,
} as const;
