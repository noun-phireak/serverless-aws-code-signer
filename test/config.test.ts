import { describe, expect, it } from 'vitest';

import { parseEnabled, resolveSignerConfig, SignerConfigError } from '../src/config';

const validRaw = {
  profileName: 'my-profile',
  source: { s3: { bucketName: 'artifacts', prefix: 'staging/' } },
  destination: { s3: { bucketName: 'artifacts', prefix: 'signed/' } },
};

describe('parseEnabled', () => {
  it('treats a missing flag as enabled', () => {
    expect(parseEnabled(undefined)).toBe(true);
    expect(parseEnabled(null)).toBe(true);
  });

  it('accepts booleans', () => {
    expect(parseEnabled(true)).toBe(true);
    expect(parseEnabled(false)).toBe(false);
  });

  it('accepts the strings serverless produces for booleans', () => {
    expect(parseEnabled('true')).toBe(true);
    expect(parseEnabled('false')).toBe(false);
    expect(parseEnabled(' FALSE ')).toBe(false);
  });

  // Reading this in the constructor, before Serverless has resolved variables,
  // would sign even when the flag says false: an unresolved "${...}" is a
  // truthy string.
  it('refuses to guess when the variable is unresolved', () => {
    expect(() => parseEnabled('${self:custom.env.ENABLED_AWS_SIGNER}')).toThrow(SignerConfigError);
    expect(() => parseEnabled('${self:custom.env.ENABLED_AWS_SIGNER}')).toThrow(/unresolved/i);
  });

  it('rejects values that are neither boolean nor boolean-ish', () => {
    expect(() => parseEnabled('yes')).toThrow(SignerConfigError);
    expect(() => parseEnabled(1)).toThrow(SignerConfigError);
  });
});

describe('resolveSignerConfig', () => {
  it('throws when the plugin is loaded without config rather than skipping', () => {
    expect(() => resolveSignerConfig(undefined)).toThrow(/custom\.signer` is missing/);
  });

  it('short-circuits when disabled without requiring the rest of the config', () => {
    expect(resolveSignerConfig({ enabled: false }).enabled).toBe(false);
  });

  it('defaults signingPolicy to Enforce', () => {
    expect(resolveSignerConfig(validRaw).signingPolicy).toBe('Enforce');
  });

  it('defaults the destination bucket to the source bucket', () => {
    const config = resolveSignerConfig({ ...validRaw, destination: undefined });
    expect(config.destination.bucketName).toBe('artifacts');
  });

  it('requires a profile name', () => {
    expect(() => resolveSignerConfig({ ...validRaw, profileName: undefined })).toThrow(
      /profileName is required/
    );
  });

  it('rejects an unresolved profile name instead of looking up a literal "${...}"', () => {
    expect(() =>
      resolveSignerConfig({ ...validRaw, profileName: '${ssm:/lambda/signing-profile-name}' })
    ).toThrow(/unresolved variable/);
  });

  it('rejects an unknown signing policy', () => {
    expect(() => resolveSignerConfig({ ...validRaw, signingPolicy: 'Ignore' })).toThrow(
      /signingPolicy must be one of/
    );
  });

  it('accepts retain for drop-in compatibility and ignores it', () => {
    expect(() => resolveSignerConfig({ ...validRaw, retain: true })).not.toThrow();
  });
});

describe('signCustomResources', () => {
  // If signing is on at all, every function this plugin can sign gets signed.
  // Leaving a framework-injected Lambda unsigned is a gap, not a default.
  it('defaults to on, so opting out is the deliberate choice', () => {
    expect(resolveSignerConfig(validRaw).signCustomResources).toBe(true);
  });

  it('accepts booleans and the strings serverless produces for them', () => {
    expect(
      resolveSignerConfig({ ...validRaw, signCustomResources: true }).signCustomResources
    ).toBe(true);
    expect(
      resolveSignerConfig({ ...validRaw, signCustomResources: 'true' }).signCustomResources
    ).toBe(true);
    expect(
      resolveSignerConfig({ ...validRaw, signCustomResources: 'false' }).signCustomResources
    ).toBe(false);
  });

  it('refuses to guess when the variable is unresolved', () => {
    expect(() =>
      resolveSignerConfig({ ...validRaw, signCustomResources: '${self:custom.signCustom}' })
    ).toThrow(/unresolved/i);
  });

  it('rejects values that are neither boolean nor boolean-ish', () => {
    expect(() => resolveSignerConfig({ ...validRaw, signCustomResources: 'yes' })).toThrow(
      SignerConfigError
    );
  });
});
