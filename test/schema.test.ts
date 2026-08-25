import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

import { configSchema } from '../src/config';

/**
 * Serverless compiles every plugin's schema with AJV in strict mode and aborts
 * the whole framework if one fails -- "At least one of the plugins defines a
 * validation schema that is invalid", with no indication of which plugin.
 *
 * A union type (`type: ['boolean','string']`) is rejected by strictTypes, which
 * shipped in 1.0.0 and made the plugin unloadable. Compile it here so that can
 * never reach a release again.
 */
describe('configSchema', () => {
  it('compiles under AJV strict mode', () => {
    const ajv = new Ajv({ strict: true });
    expect(() => ajv.compile(configSchema)).not.toThrow();
  });

  it('accepts the config shapes the plugin documents', () => {
    const validate = new Ajv({ strict: true }).compile(configSchema);

    expect(validate({ profileName: 'p', source: { s3: { bucketName: 'b' } } })).toBe(true);
    expect(validate({ enabled: true })).toBe(true);
    expect(validate({ enabled: 'false' })).toBe(true);
    expect(validate({ retain: true })).toBe(true);
    expect(validate({ signCustomResources: true })).toBe(true);
    expect(validate({ signCustomResources: 'false' })).toBe(true);
    expect(validate({ signingPolicy: 'Enforce' })).toBe(true);
    expect(validate({ signingPolicy: 'Warn' })).toBe(true);
  });

  it('rejects what it should', () => {
    const validate = new Ajv({ strict: true }).compile(configSchema);

    expect(validate({ enabled: 123 })).toBe(false);
    expect(validate({ signCustomResources: 123 })).toBe(false);
    expect(validate({ signingPolicy: 'enforce' })).toBe(false);
    expect(validate({ typoedKey: 1 })).toBe(false);
    expect(validate({ source: { s3: { prefix: 'p/' } } })).toBe(false); // bucketName required
  });
});
