# serverless-aws-code-signer

Sign Lambda deployment artifacts with [AWS Signer](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html) during `serverless deploy`, and attach an `AWS::Lambda::CodeSigningConfig` to every function in the stack.

It signs the packaged zip *before* the framework hashes it, so `AWS::Lambda::Version.CodeSha256` describes the bytes that actually get uploaded.

## Design principles

**Fail closed.** Every ambiguous state is an error, never a silent skip. If the plugin cannot tell whether signing should run, the deploy fails.

**Never create infrastructure.** The plugin will not create a signing profile or an S3 bucket. A typo in `profileName` fails the deploy instead of minting a fresh, unreviewed profile that happens to satisfy the config — which is the whole point of code signing.

**Verify what you ship.** The signed artifact is read back off disk and its size checked against what was written, and its `CodeSha256` is logged so a CloudFormation mismatch is diagnosable from the deploy log alone.

## Install

```bash
npm install --save-dev serverless-aws-code-signer
```

```yaml
plugins:
  - serverless-aws-code-signer
```

## Configure

```yaml
custom:
  signer:
    enabled: true            # optional, default true
    profileName: my-signing-profile
    signingPolicy: Enforce   # Enforce (default) | Warn
    timeoutSeconds: 300      # optional, default 300
    source:
      s3:
        bucketName: my-artifacts-bucket   # must exist and have versioning enabled
        prefix: signing/staging/
    destination:
      s3:
        bucketName: my-artifacts-bucket   # optional, defaults to source bucket
        prefix: signing/signed/
```

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | no | `true` | Boolean, or the strings `"true"`/`"false"`. An unresolved `${...}` is an error. |
| `profileName` | yes | — | Must already exist and be `Active`. |
| `signingPolicy` | no | `Enforce` | Maps to `UntrustedArtifactOnDeployment`. |
| `timeoutSeconds` | no | `300` | Cap on waiting for the signing job. |
| `source.s3.bucketName` | yes | — | **Versioning must be enabled** — Signer needs an object version. |
| `source.s3.prefix` | no | `''` | Prefix for the staged unsigned artifact. |
| `destination.s3.bucketName` | no | source bucket | Where Signer writes the signed artifact. |
| `destination.s3.prefix` | no | `''` | Prefix for the signed artifact. |
| `retain` | no | — | Accepted for drop-in compatibility and ignored. |

Works with `package.individually: true` (each function signed separately) and with a single service-wide artifact. Container-image functions are skipped.

### Credentials

Uses the standard AWS SDK credential chain and the region Serverless resolved for the deploy. Set `AWS_PROFILE` if you need a named profile.

The deploy role needs:

- `signer:GetSigningProfile`, `signer:StartSigningJob`, `signer:DescribeSigningJob`
- `s3:HeadBucket`, `s3:PutObject`, `s3:GetObject` on the source and destination buckets

### Turning signing off per stage

`enabled` is read inside the lifecycle hook, after Serverless has resolved variables, so a stage-driven flag is honoured:

```yaml
custom:
  signer:
    enabled: ${self:custom.env.ENABLED_AWS_SIGNER}
```

If that variable is still unresolved when the hook runs, the deploy fails with a clear message rather than guessing. A signing plugin that cannot tell whether it should run must not pick an answer: guessing "on" ships an unwanted signature, guessing "off" ships unsigned code.

## Migrating from `@ioiotv/serverless-aws-signer`

The `custom.signer` schema is compatible, so the migration is one line:

```diff
 plugins:
-  - "@ioiotv/serverless-aws-signer"
+  - serverless-aws-code-signer
```

Two behaviour changes to expect:

- **One `CodeSigningConfig` resource instead of one per function.** The old plugin created N configs and pointed every function at the last one, orphaning the rest. The first deploy after migrating replaces them with a single `CodeSigningConfig` resource.
- **Signing profiles and buckets are no longer auto-created.** If your pipeline relied on that, create them out-of-band first.

The `signer` CLI command and layer signing are not implemented.

### Why this exists

`@ioiotv/serverless-aws-signer` replaced the packaged zip with:

```js
await fs.writeFile(signItem.packageArtifact, Body)   // callback API, no callback
```

Serverless gracefulify's `fs`, and graceful-fs supplies its own callback rather than throwing on the missing one. So the `await` resolves immediately, with the zip already truncated to zero bytes by the open-for-write. `package:compileFunctions` then hashes the empty file into `AWS::Lambda::Version.CodeSha256` while the complete artifact is what gets uploaded, and CloudFormation rejects the version:

```
CodeSHA256 (47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=) is different from
current CodeSHA256 in $LATEST (...)
```

`47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=` is the SHA256 of zero bytes. There is a regression test for this in `test/signing.test.ts`.

Other fixed defects: the enabled flag being read in the constructor before variable resolution (an unresolved `"${...}"` is truthy, so it signed when told not to); auto-creation of signing profiles and buckets; a `describeSigningJob` poll loop with no delay and no timeout; no verification of the signed artifact; revoking the signing profile on `sls remove`; and AWS SDK v2, whose `provider.request()` surface is removed in osls 4.x.

## License

MIT
