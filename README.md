# serverless-aws-code-signer

[![npm](https://img.shields.io/npm/v/serverless-aws-code-signer.svg)](https://www.npmjs.com/package/serverless-aws-code-signer)
[![CI](https://github.com/noun-phireak/serverless-aws-code-signer/actions/workflows/ci.yml/badge.svg)](https://github.com/noun-phireak/serverless-aws-code-signer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/serverless-aws-code-signer.svg)](./LICENSE)

Sign Lambda deployment artifacts with [AWS Signer](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html) during `serverless deploy`, and attach an `AWS::Lambda::CodeSigningConfig` to every function in the stack.

The signing happens *before* the framework hashes the zip, so `AWS::Lambda::Version.CodeSha256` always describes the bytes that actually reach Lambda.

```yaml
plugins:
  - serverless-aws-code-signer

custom:
  signer:
    profileName: my-signing-profile
    source:
      s3:
        bucketName: my-artifacts-bucket
        prefix: signing/staging/
```

That is the whole configuration. Everything else has a secure default.

## Documentation

| | |
| --- | --- |
| [Getting started](./docs/getting-started.md) | AWS prerequisites, install, first signed deploy, how to verify it worked |
| [Configuration](./docs/configuration.md) | Every option, per-stage toggling, IAM policies |
| [How it works](./docs/how-it-works.md) | Lifecycle hooks, what it does to your CloudFormation template |
| [Troubleshooting](./docs/troubleshooting.md) | Every error the plugin can raise, and the fix |
| [Migrating from `@ioiotv/serverless-aws-signer`](./docs/migration.md) | One-line swap, plus the behaviour changes to expect |
| [Changelog](./CHANGELOG.md) | What changed in each release |

## Requirements

- Node.js 18+
- Serverless Framework v3 / [osls](https://github.com/oss-serverless/serverless) 3.x or 4.x
- An existing AWS Signer profile and a **versioning-enabled** S3 bucket

## Design principles

**Fail closed.** Every ambiguous state is an error, never a silent skip. If the plugin cannot tell whether signing should run — an unresolved variable, a missing config block — the deploy fails rather than guessing. Guessing "on" ships an unwanted signature; guessing "off" ships unsigned code.

**Never create infrastructure.** The plugin will not create a signing profile or an S3 bucket. A typo in `profileName` fails the deploy instead of minting a fresh, unreviewed profile that happens to satisfy the config — which would defeat the entire point of code signing.

**Verify what you ship.** The signed artifact is read back off disk and its size checked against what was written, and its `CodeSha256` is logged, so a CloudFormation mismatch is diagnosable from the deploy log alone.

## Scope

Supported: `package.individually: true` and single-artifact packaging, `serverless deploy`, `serverless deploy function`, per-stage enable/disable, container-image functions (skipped, not an error).

Not implemented: Lambda layer signing, a standalone `serverless signer` CLI command.

## License

MIT
