# serverless-aws-code-signer

[![npm](https://img.shields.io/npm/v/serverless-aws-code-signer.svg)](https://www.npmjs.com/package/serverless-aws-code-signer)
[![CI](https://github.com/noun-phireak/serverless-aws-code-signer/actions/workflows/ci.yml/badge.svg)](https://github.com/noun-phireak/serverless-aws-code-signer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/serverless-aws-code-signer.svg)](./LICENSE)

Sign Lambda deployment artifacts with [AWS Signer](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html) during `serverless deploy`, and attach an `AWS::Lambda::CodeSigningConfig` to every function in the stack.

The signing happens *before* the framework hashes the zip, so `AWS::Lambda::Version.CodeSha256` always describes the bytes that actually reach Lambda.

## Install

```bash
npm install --save-dev serverless-aws-code-signer
```

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

Both the signing profile and the bucket must already exist — see
[Getting started](./docs/getting-started.md) for the AWS setup and for how to
confirm that unsigned code is actually being rejected.

## Documentation

| Guide | Covers |
| --- | --- |
| [Getting started](./docs/getting-started.md) | AWS prerequisites, install, first signed deploy, how to verify it worked |
| [Configuration](./docs/configuration.md) | Every option, per-stage toggling, IAM policies |
| [How it works](./docs/how-it-works.md) | Lifecycle hooks, what it does to your CloudFormation template |
| [Troubleshooting](./docs/troubleshooting.md) | Every error the plugin can raise, and the fix |
| [Security policy](./SECURITY.md) | Threat model, supported versions, reporting a vulnerability |
| [Changelog](./CHANGELOG.md) | What changed in each release |

## Requirements

- **Node.js** 20.19 or later
- **Serverless Framework** 3.x, or [osls](https://github.com/oss-serverless/serverless) 3.x / 4.x
- **An existing AWS Signer profile**, `Active`, on the `AWSLambda-SHA384-ECDSA` platform
- **An existing S3 bucket with versioning enabled** — AWS Signer addresses its input by version ID

## Design principles

**Fail closed.** Every ambiguous state is an error, never a silent skip. If the plugin cannot tell whether signing should run — an unresolved variable, a missing config block — the deploy fails rather than guessing. Guessing "on" ships an unwanted signature; guessing "off" ships unsigned code.

**Never create infrastructure.** The plugin will not create a signing profile or an S3 bucket. A typo in `profileName` fails the deploy instead of minting a fresh, unreviewed profile that happens to satisfy the config — which would defeat the entire point of code signing.

**Verify what you ship.** The signed artifact is read back off disk and its size checked against what was written, and its `CodeSha256` is logged, so a CloudFormation mismatch is diagnosable from the deploy log alone.

## Scope

Supported: `package.individually: true` and single-artifact packaging, `serverless deploy`, `serverless deploy function`, per-stage enable/disable, container-image functions (skipped, not an error).

Not implemented: Lambda layer signing, a standalone `serverless signer` CLI command.

## Security

This plugin sits in your deploy path and calls AWS Signer on your behalf. The
[security policy](./SECURITY.md) documents the threat model — including what
code signing does *not* protect against — and how to report a vulnerability
privately.

Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so the published tarball is cryptographically linked to the commit and workflow
run that built it. Verify your install with `npm audit signatures`.

## Contributing

Issues and pull requests are welcome at
[github.com/noun-phireak/serverless-aws-code-signer](https://github.com/noun-phireak/serverless-aws-code-signer).

Please do not report security vulnerabilities through public issues — follow the
[security policy](./SECURITY.md) instead.

## License

[MIT](./LICENSE)
