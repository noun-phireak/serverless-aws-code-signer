# How it works

The plugin does two independent things:

1. **Replaces each local zip with its signed equivalent**, before the framework hashes it.
2. **Adds one `AWS::Lambda::CodeSigningConfig`** to the template and points every function at it.

The ordering in step 1 is the whole point. Read [Why the ordering matters](#why-the-ordering-matters) if you read nothing else.

## Lifecycle hooks

| Hook | Method | What it does |
| --- | --- | --- |
| `after:package:createDeploymentArtifacts` | `signFunctions` | Signs every artifact after `serverless deploy` packages them |
| `after:deploy:function:packageFunction` | `signFunctions` | Same, for `serverless deploy function -f name` |
| `before:package:finalize` | `attachCodeSigningConfig` | Injects the code-signing config into the compiled template |

### Hooks are registered unconditionally

All three hooks are always registered, and `enabled` is read *inside* them rather than in the constructor.

This is deliberate. A plugin constructor runs before Serverless has finished resolving variables, so `enabled: ${self:custom.foo}` is still the literal string `"${self:custom.foo}"` at that point — which is truthy. Deciding in the constructor means the flag cannot be trusted in either direction. Reading it inside the hook means variables have resolved, and an unresolved one can be detected and rejected.

## Signing a deploy, step by step

### 1. Resolve and validate config

`custom.signer` is parsed into a fully-checked config. Missing config is an error, not a skip — if the plugin is listed in `plugins`, it will not silently do nothing.

If `enabled` resolves to false, the plugin logs that artifacts are being left unsigned and returns. Nothing else in this list happens.

### 2. Collect targets

**With `package.individually: true`** — one target per function, skipping:
- Container-image functions (they carry no zip)
- Every function except `-f <name>`, when running `serverless deploy function`

A function with no `package.artifact` at this stage is an error: signing runs after packaging, so a missing zip means packaging did not produce one.

**Without `package.individually`** — a single target, the service-level artifact, defaulting to `.serverless/<service-name>.zip`.

### 3. Validate the environment, once, up front

Before touching *any* artifact:

- `GetSigningProfile` — must exist, must be `Active`, must return a `profileVersionArn`
- `HeadBucket` on the source bucket
- `HeadBucket` on the destination bucket, if it differs

This happens before the loop so a misconfigured profile fails the deploy immediately, rather than after half your functions have been signed and rewritten. Partial signing is the state you least want to debug.

### 4. Sign each artifact

Per target:

1. Read the local zip. **A zero-byte artifact is an error** — refuse to sign an empty zip.
2. `PutObject` to `<source.prefix><functionName>-<timestamp>-<uuid>`. The timestamp and UUID make concurrent deploys collision-free.
3. **Assert the response carried a `VersionId`.** No version ID means the bucket is unversioned, and AWS Signer cannot address its input. Fail with that specific message rather than a confusing Signer error later.
4. `StartSigningJob` with the source version and the destination bucket/prefix, using a fresh `clientRequestToken` for idempotency.
5. Poll `DescribeSigningJob` — 1s, doubling to a 10s ceiling, until `timeoutSeconds`. `Failed` surfaces the `statusReason`; the timeout reports the last status seen.
6. `GetObject` the signed artifact. An empty body is an error.
7. Overwrite the local zip with the signed bytes.
8. **`stat` the file and compare its size to what was written.** See below.
9. Log the function name, size, base64 `CodeSha256`, and job ID — at `notice`, so it is visible without `--verbose`.

### 5. Attach the code-signing config

On `before:package:finalize`, one `AWS::Lambda::CodeSigningConfig` resource is added with logical ID `CodeSigningConfig`:

```yaml
CodeSigningConfig:
  Type: AWS::Lambda::CodeSigningConfig
  Properties:
    Description: Managed by serverless-aws-code-signer for <service-name>
    AllowedPublishers:
      SigningProfileVersionArns:
        - <profileVersionArn>
    CodeSigningPolicies:
      UntrustedArtifactOnDeployment: Enforce
```

Then every `AWS::Lambda::Function` in the template gets `CodeSigningConfigArn: {Ref: CodeSigningConfig}` — except:

- **Container-image functions** (`PackageType: Image`), which cannot carry the property at all
- **Functions not declared in your `serverless.yml`**, matched by `FunctionName`. This leaves alone the Lambdas that other plugins inject into the template — log subscribers, warmers — which are not yours to sign.
- **Serverless's own custom-resource Lambdas** are included by default — see [step 6](#6-the-frameworks-own-custom-resources). Set [`signCustomResources: false`](./configuration.md#signcustomresources) to opt out.

Whatever is left out is [named in the deploy log](./configuration.md#coverage-accounting) rather than skipped quietly.

Note that `AllowedPublishers` pins the profile **version** ARN. Rotating the signing profile changes that ARN, so the next deploy updates the config; artifacts signed with the old version stop being trusted. That is the intended behaviour of a rotation.

### 6. The framework's own custom resources

Some events make Serverless inject a Lambda of its own during
`package:compileEvents` — an `s3` event with `existing: true`, `eventBridge`,
an existing `cognitoUserPool`, or the API Gateway CloudWatch role. They all share
one artifact, `.serverless/custom-resources.zip`.

That artifact is signed and those functions get the `CodeSigningConfigArn`, by
default. The timing is different from everything above, and deliberately so:

| | user function artifacts | custom-resources.zip |
| --- | --- | --- |
| Written by | packaging, at `package:createDeploymentArtifacts` | the framework, at `package:compileEvents` |
| Signed at | `after:package:createDeploymentArtifacts` | `before:package:finalize` |
| Hashed into `AWS::Lambda::Version.CodeSha256` | **yes** | **no** — no Version resource is generated |
| Read for upload at | `deploy:deploy` | `deploy:deploy` |

The zip does not exist when `signFunctions` runs, so it cannot be signed there.
`before:package:finalize` is the one window where it is both present and not yet
uploaded. Signing it that late is safe precisely because nothing hashes it —
the `CodeSha256` hazard that shapes the rest of this plugin does not apply.

Two further details make this safe:

- The file in `.serverless/` is a plain copy of the framework's global cache in
  `~/.serverless/artifacts/<version>/`, so overwriting it in place cannot poison
  that cache for other services on the same machine.
- The artifact is signed **before** any function is pointed at the code-signing
  config. Attaching an `Enforce` policy to a function whose zip was never signed
  just moves the failure to CloudFormation.

Functions matching neither your `serverless.yml` nor this artifact — Lambdas that
third-party plugins inject — cannot be signed: their artifacts are not ours to
find, and attaching a policy to an unsigned function would only break the deploy.
They are **named in a warning** rather than silently ignored, so
[coverage is accountable](./configuration.md#coverage-accounting).

## What the deploy log tells you

Serverless log levels are ordered `error` > `warning` > `notice` > `info` > `debug`, and the default threshold is **`notice`**. `--verbose` lowers it to `info`.

Anything that answers *"did this deploy get signed, and with what?"* is therefore emitted at `notice`, because the place that question gets asked is a CI log that nobody re-runs with `--verbose`:

| Message | Level | Meaning |
| --- | --- | --- |
| `Signing N artifact(s) with AWS Signer profile "..." (policy ...)` | `notice` | Signing started, and with which profile |
| `Signed <fn> -> <zip> (N bytes, CodeSha256 ..., job ...)` | `notice` | One artifact is signed; the hash is the evidence |
| `Attached CodeSigningConfig (...) to N function(s)` | `notice` | The template side is wired up |
| `Signing the Serverless-generated custom-resource artifact` | `notice` | The framework's own custom resources are being signed |
| `N Lambda(s) generated by Serverless will deploy UNSIGNED because ...` | `warning` | You opted out with `signCustomResources: false` |
| `N Lambda(s) in this stack are NOT signed and cannot be ...` | `warning` | Another plugin injected them; artifacts not locatable |
| `N container-image function(s) carry no code-signing config` | `notice` | AWS Signer does not cover images |
| `Code signing is disabled for this stage; artifacts left unsigned.` | `notice` | Deliberately off — never silent |
| `Code signing is enabled but no function artifacts were found to sign.` | `warning` | Enabled but did nothing; almost always a packaging problem |
| `custom.signer.retain is accepted but ignored...` | `warning` | Deprecated option present |
| Signing profile version ARN, per-artifact start | `info` | `--verbose` only |
| Job polling status | `debug` | `--verbose` only |

The rule: **a deploy that signs is never silent, and a deploy that skips signing says so.** A code-signing plugin whose output is invisible at default verbosity cannot be audited from CI, which defeats most of the point of running it.

## Why the ordering matters

`after:package:createDeploymentArtifacts` fires **before** `package:compileFunctions` computes `AWS::Lambda::Version.CodeSha256`. So the sequence is:

```
package the zip → sign it in place → hash it → upload it
```

The hash therefore describes the signed bytes — the ones that actually reach Lambda.

Get this backwards and you hash the *unsigned* zip while uploading the *signed* one, and CloudFormation rejects the version with a `CodeSha256` mismatch. Worse is the near-miss: a signing step that writes the file asynchronously without awaiting it. The framework then hashes a **truncated or empty** file, and the mismatch shows up as an opaque CloudFormation error at deploy time, far from its cause.

That is exactly the bug this plugin was written to avoid, which is why step 4 does two things that look redundant:

- The write is `fsp.writeFile` and is genuinely **awaited**. (Serverless calls `graceful-fs`'s `gracefulify` on `fs`, so a callback-style `fs.writeFile` invoked with no callback returns immediately and leaves the zip truncated to zero bytes.)
- The size is **read back off disk** and compared. If the write ever silently misbehaves again, the deploy fails right there with a precise message, instead of surfacing as a `CodeSha256` mismatch inside CloudFormation ten minutes later.

The `CodeSha256` in the log exists for the same reason: when something does go wrong, the deploy log alone is enough to diagnose it.

## What ends up in S3

Two objects per function per deploy, neither cleaned up by the plugin:

| Object | Location | Purpose |
| --- | --- | --- |
| Staged unsigned zip | `source.bucketName/<source.prefix>...` | Input to the signing job |
| Signed zip | `destination.bucketName/<destination.prefix>...` | Output; the auditable record |

Put a lifecycle rule on the staging prefix. See [Configuration → `source.s3`](./configuration.md#sources3).

## Interaction with other plugins

The plugin reads `functionObject.package.artifact`, so it works with any packaging plugin that populates it — `serverless-webpack`, `serverless-esbuild`, and similar — as long as that plugin has finished by `after:package:createDeploymentArtifacts`. That is the normal contract, since it is the hook after artifacts are declared complete.

Because only functions declared in your `serverless.yml` get a `CodeSigningConfigArn`, plugins that inject their own Lambdas into the template are unaffected.
