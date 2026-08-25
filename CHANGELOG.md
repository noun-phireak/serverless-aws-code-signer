# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-25

Initial release.

### Added

- Sign Lambda deployment artifacts with AWS Signer during `serverless deploy`,
  hooked on `after:package:createDeploymentArtifacts` — before the framework
  hashes the zip, so `AWS::Lambda::Version.CodeSha256` describes the bytes that
  actually reach Lambda.
- Support for `serverless deploy function -f <name>`, via
  `after:deploy:function:packageFunction`.
- A single `AWS::Lambda::CodeSigningConfig` attached to every function declared
  in `serverless.yml`, added on `before:package:finalize`. Lambdas injected into
  the template by other plugins are left alone.
- Configuration under `custom.signer`, validated against a JSON schema with
  `additionalProperties: false` so a typo in an option name fails the deploy:
  `profileName`, `source.s3`, `destination.s3`, `enabled`, `signingPolicy`,
  `timeoutSeconds`.
- Per-stage enable/disable through `enabled`, accepting a boolean or the strings
  `"true"`/`"false"` so Serverless variables work.
- Support for both `package.individually: true` and single-artifact packaging.
- Container-image functions are skipped rather than treated as an error, so
  mixed zip/image services work without special handling.
- `destination` defaults to the source bucket; specify it only to segregate
  signed output.
- Signing job polling with exponential backoff (1s, doubling to a 10s ceiling)
  up to `timeoutSeconds`, default 300.
- Structured logging via the Serverless v3 logger, falling back to
  `serverless.cli.log` on older versions.
- TypeScript type definitions.

### Security

- **Fails closed.** Every ambiguous state is an error, never a silent skip. An
  unresolved `${...}` in `enabled` is rejected rather than coerced — guessing
  "on" ships an unwanted signature, guessing "off" ships unsigned code. Missing
  `custom.signer` is an error rather than a no-op.
- **Never creates infrastructure.** The plugin will not create a signing profile
  or an S3 bucket. A typo in `profileName` fails the deploy instead of minting a
  fresh, unreviewed profile that happens to satisfy the config.
- **Rejects inactive profiles.** A `Canceled` or `Revoked` signing profile is an
  error, not a fallback.
- **Verifies what it ships.** The signed artifact is read back off disk and its
  size checked against what was written, and its `CodeSha256` is logged, so a
  CloudFormation mismatch is diagnosable from the deploy log alone. Zero-byte
  artifacts are rejected both before and after signing.
- **Validates the environment once, up front.** The signing profile and both
  buckets are checked before any artifact is touched, so a misconfiguration
  fails before half the functions have been signed.
- **Detects unversioned source buckets.** A missing `VersionId` on upload is
  reported directly, rather than surfacing later as an opaque AWS Signer error.
- `AllowedPublishers` pins the signing profile *version* ARN, so rotating the
  profile stops the previous version being trusted on the next deploy.

[Unreleased]: https://github.com/noun-phireak/serverless-aws-code-signer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/noun-phireak/serverless-aws-code-signer/releases/tag/v0.1.0
