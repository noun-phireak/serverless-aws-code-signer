# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-08-25

### Fixed

- **Signing was invisible in the deploy log.** Serverless log levels run
  `error` > `warning` > `notice` > `info` > `debug` with a default threshold of
  `notice`, and every message the plugin emitted was `info` — below the
  threshold, so shown only under `--verbose`. The only line that appeared in a
  normal deploy was the `retain` warning, which sits above it. A CI log
  therefore gave no evidence that anything had been signed, which for a
  code-signing plugin is most of the point. Every message that answers "was this
  signed, and with what?" is now emitted at `notice`.

### Added

- **Serverless-generated Lambdas are now signed too, by default.** Events like
  an `s3` event with `existing: true`, `eventBridge`, an existing
  `cognitoUserPool`, or any `http` event make the framework inject a Lambda of
  its own during `package:compileEvents`. They are not declared in
  `serverless.yml`, but they run code in your account with IAM permissions to
  reconfigure buckets and event sources, so leaving them unsigned was a real
  supply-chain gap for anyone who can write to the deployment bucket. All of
  them share one artifact, so this costs one extra signing job per deploy no
  matter how many such events a service has.

  The artifact is signed on `before:package:finalize`, which is the only window
  where it exists (Serverless writes it during `package:compileEvents`, after
  `signFunctions` has run) and has not yet been uploaded. Signing that late
  carries no `CodeSha256` risk because no `AWS::Lambda::Version` resource hashes
  it. It is signed before any function is pointed at the code-signing config, so
  an `Enforce` policy is never attached to an unsigned artifact. The file in
  `.serverless/` is a plain copy of the framework's global artifact cache, so
  overwriting it cannot poison that cache for other services.

  They are identified by the artifact they run (`custom-resources.zip`) rather
  than by logical ID, since the framework's logical IDs are internals that have
  changed shape before.
- **`custom.signer.signCustomResources`** (default `true`) to opt out of the
  above. Opting out names the affected functions in a warning on every deploy;
  there is no way to leave them unsigned quietly.
- **Coverage accounting.** Every `AWS::Lambda::Function` in the compiled template
  is now placed in exactly one category, and anything the plugin cannot sign is
  **named** in the deploy log rather than skipped in silence:
  - Lambdas injected by third-party plugins — a warning, listed by name. Their
    artifacts cannot be located, so they cannot be signed; the plugin will not
    attach an `Enforce` policy to an artifact it never signed, since that turns a
    coverage gap into a broken deploy without improving security.
  - Container-image functions — a notice, listed by name. `PackageType: Image`
    cannot carry a `CodeSigningConfigArn`; the equivalent control is ECR image
    signing.

  This makes "is every function in this stack signed?" answerable from the deploy
  log instead of assumed.
- `Attached CodeSigningConfig (<policy>) to N function(s)` on
  `before:package:finalize`, so the template side of the plugin is visible in
  the log too.
- The per-artifact line now names the function as well as the zip:
  `Signed <fn> -> <zip> (N bytes, CodeSha256 ..., job ...)`.
- Tests asserting that these messages are emitted at `notice`, so they cannot
  sink below the default log threshold again.

### Changed

- "No function artifacts to sign" is now a **warning** rather than an info
  message. Signing enabled but nothing signed is almost always a packaging
  problem, and it should not be quiet.
- The signing profile version ARN and a per-artifact start line are logged at
  `info` (`--verbose`), for auditing which profile version a deploy used.

## [1.0.3] - 2026-08-25

### Fixed

- **The plugin could not be loaded at all.** `custom.signer.enabled` was declared
  as a union type (`type: ['boolean', 'string']`), which AJV rejects under the
  strict mode Serverless compiles plugin schemas with. Any `serverless` command
  failed with "At least one of the plugins defines a validation schema that is
  invalid" before a single hook ran, and the message names no plugin. Declared as
  `anyOf` instead; accepted values are unchanged.
- The `retain` deprecation warning no longer fires when signing is disabled for
  the stage. A disabled plugin now stays silent instead of warning about an
  option it was never going to act on.

### Added

- A test that compiles the config schema with AJV in strict mode, so an
  unloadable schema cannot reach a release again.

## [1.0.2] - 2026-08-25

### Added

- `custom.signer.retain` now logs a warning saying it is ignored, instead of
  being silently dropped. It remains accepted so existing configs keep loading,
  and is scheduled for removal in the next major version.

### Changed

- The signing profile is looked up once per deploy instead of once per lifecycle
  hook, halving the `GetSigningProfile` calls a deploy makes. The resolved
  profile version ARN is unchanged: the same value is used to sign and to pin
  `AllowedPublishers` in the template.
- CI now runs on `actions/checkout@v7` and `actions/setup-node@v7`, clearing the
  GitHub Actions Node 20 runtime deprecation warning.

## [1.0.0] - 2026-08-25

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
- Requires Node.js 20.19 or later.

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

[Unreleased]: https://github.com/noun-phireak/serverless-aws-code-signer/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/noun-phireak/serverless-aws-code-signer/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/noun-phireak/serverless-aws-code-signer/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/noun-phireak/serverless-aws-code-signer/compare/v1.0.0...v1.0.2
[1.0.0]: https://github.com/noun-phireak/serverless-aws-code-signer/releases/tag/v1.0.0
