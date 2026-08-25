# Troubleshooting

Every error this plugin can raise, and the fix. Errors come from two classes: `SignerConfigError` (bad `serverless.yml`, raised before any AWS call) and `SigningError` (something wrong with AWS state or the artifact).

At the bottom there are also [AWS-side errors](#aws-side-errors-not-raised-by-the-plugin) that surface during or after a deploy but come from CloudFormation or Lambda.

## Configuration errors

### `serverless-aws-code-signer is listed in `plugins` but `custom.signer` is missing.`

> Configure it, or remove the plugin — it will not silently skip signing.

Add a `custom.signer` block ([minimal config](./configuration.md#minimal-config)), or remove the plugin from `plugins`.

If you meant "installed but off for this stage", that is `enabled: false` — an explicit choice, which is the point. The plugin will not treat missing config as consent to ship unsigned code.

### `custom.signer.enabled is still an unresolved variable ("...")`

> Refusing to guess whether code signing should run.

A Serverless variable did not resolve for this stage — a typo, a missing key with no fallback, or a reference to a file/SSM parameter that is not available.

Give the variable a fallback so it always resolves:

```yaml
enabled: ${self:custom.signerEnabled.${sls:stage}, 'false'}
```

Debug what it resolves to with `serverless print --stage <stage>`.

The plugin refuses to guess here rather than treating the truthy string `"${...}"` as `true`. Guessing "on" ships an unwanted signature; guessing "off" ships unsigned code. Neither is a decision a tool should make for you.

### `custom.signer.enabled must be a boolean (or the string "true"/"false"), received ...`

You passed something else — most often `yes`/`no`/`1`/`0`. Use `true`/`false`, or the quoted strings `'true'`/`'false'` when the value comes from a variable.

### `custom.signer.profileName is required and must be a non-empty string.`

Missing, empty, or whitespace-only, on a stage where signing is enabled. Set it to an existing AWS Signer profile name.

If this fires on a stage that should *not* sign, the real problem is that `enabled` is resolving to true — disabled stages skip this validation entirely.

### `custom.signer.source.s3.bucketName is required and must be a non-empty string.`

Same as above, for the staging bucket.

### `<property> is still an unresolved variable ("...")`

The generic form of the `enabled` case, for `profileName`, `source.s3.bucketName`, `source.s3.prefix`, `destination.s3.bucketName`, or `destination.s3.prefix`. Same fix: give the variable a fallback that resolves for every stage.

### `custom.signer.signingPolicy must be one of Enforce, Warn, received ...`

Case-sensitive. `enforce` is not `Enforce`.

### `custom.signer.timeoutSeconds must be a positive number, received ...`

Must be a finite number greater than zero. A numeric string like `"600"` is accepted and coerced; `"10m"` is not.

### `... must NOT have additional properties`

Not from the plugin directly — this is Serverless validating against the plugin's schema, which sets `additionalProperties: false`. You have a typo in an option name (`profile` instead of `profileName`, `sourceBucket` instead of the nested `source.s3.bucketName`).

Deliberate: a silently-ignored typo in a signing config means signing silently does not happen the way you think it does. Check the [full option list](./configuration.md#full-reference).

## Profile and bucket errors

### `Signing profile "..." does not exist in this account/region.`

> Create it out-of-band (Terraform/SRE) and re-run — this plugin will not create it.

Either a typo, or you are deploying to a different region or account than the one holding the profile. Signer profiles are **regional**:

```bash
aws signer list-signing-profiles --region <your-deploy-region>
```

The plugin will not create it for you. A typo silently minting a fresh, unreviewed profile that happens to satisfy the config would defeat the entire point of code signing.

### `Signing profile "..." is <status>, not Active. Refusing to sign.`

The profile is `Canceled` or `Revoked`. Revocation is a deliberate act meaning "artifacts signed with this are no longer trusted" — signing new code with it would be pointless, since Lambda would reject the result.

Create a replacement profile and update `profileName`.

### `Signing profile "..." returned no profileVersionArn. Refusing to sign.`

An unusual API response. Confirm the profile is fully created and healthy with `aws signer get-signing-profile --profile-name <name>`. If it is, retry — this may be transient.

### `S3 bucket "..." does not exist.`

> Create it out-of-band and re-run — this plugin will not create it.

A typo, or the bucket is in a different account. Note that S3 bucket names are global but access is regional-ish — confirm you are looking at the right account with `aws sts get-caller-identity`.

### `No permission to access S3 bucket "...". Check the deploy role's s3 permissions.`

The `HeadBucket` call returned `403`. Almost always a missing **`s3:ListBucket` on the bucket ARN itself** — not the `/*` object ARN, and note there is no such IAM action as `s3:HeadBucket`:

```json
{
  "Effect": "Allow",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::my-artifacts-bucket"
}
```

See [IAM permissions](./configuration.md#iam-permissions) for the full policy. Also check for a restrictive bucket policy, an SCP, or a VPC endpoint policy in front of it.

## Signing job errors

### `S3 bucket "..." returned no VersionId. AWS Signer requires a versioned source bucket; enable versioning on it.`

The most common first-deploy failure. AWS Signer addresses its input object by version ID, so the source bucket **must** have versioning enabled:

```bash
aws s3api put-bucket-versioning \
  --bucket my-artifacts-bucket \
  --versioning-configuration Status=Enabled
```

If versioning was only just enabled, note that it applies to new uploads — re-run the deploy.

### `Signing job <id> failed: <reason>`

The `statusReason` comes straight from AWS Signer. Common causes:

- **The profile's platform is wrong.** Lambda signing needs `AWSLambda-SHA384-ECDSA`. A profile created for a different platform will fail on a Lambda zip.
- **Signer cannot read the source object** — check bucket policy and any KMS key policy on an SSE-KMS bucket.
- **The artifact is not a valid zip** — an upstream packaging plugin produced something malformed.

Inspect the job directly:

```bash
aws signer describe-signing-job --job-id <id>
```

### `Signing job <id> did not finish within <n>s (last status: ...)`

The job did not reach a terminal state before `timeoutSeconds` (default 300).

Check whether it eventually succeeded — `aws signer describe-signing-job --job-id <id>`. If it did and just needed longer, raise `timeoutSeconds`. If it is still `InProgress` long after, that is an AWS-side problem worth a support case.

Signing a Lambda zip is normally seconds, so a timeout usually means something is stuck rather than slow.

### `Signing job <id> succeeded but returned no signed object location.`

### `StartSigningJob returned no jobId for "...".`

### `Signed object <key> had no body.`

Three unusual API responses from Signer/S3. Retry the deploy; if it persists, check for a bucket policy or lifecycle rule deleting the signed object between the job completing and the plugin fetching it.

### `Signed object <key> is empty. Refusing to ship it.`

Signer reported success but the object is zero bytes. Do not work around this — shipping it would deploy an empty function. Check for interference on the destination bucket (a lifecycle rule, a replication configuration, another process writing to the same prefix).

## Artifact errors

### `Function "..." has no package artifact to sign.`

> Signing runs after packaging; check that the packaging plugin produced a zip.

With `package.individually: true`, a function had no `package.artifact` set after packaging. Usually a packaging plugin (`serverless-webpack`, `serverless-esbuild`) failed quietly or did not run for that function.

Run `serverless package` alone and check what actually landed in `.serverless/`.

### `Artifact <path> is empty before signing. Refusing to sign a zero-byte zip.`

The zip was zero bytes before the plugin touched it — so this is an upstream packaging failure, not a signing one. Inspect `.serverless/` after `serverless package`.

### `Wrote <n> bytes of signed artifact to <path> but the file is <m> bytes.`

The signed bytes were written but the file on disk is a different size. This is the plugin's last-line integrity check, and it should never fire.

If it does, the likely causes are a full disk, a filesystem or antivirus tool interfering, or another process writing to `.serverless/` concurrently. Do not bypass it — this check is precisely what turns a silent `CodeSha256` mismatch inside CloudFormation into a clear, local failure. See [Why the ordering matters](./how-it-works.md#why-the-ordering-matters).

## AWS-side errors (not raised by the plugin)

### CloudFormation: `CodeSha256 mismatch` / `Uploaded file must be a non-empty zip`

The hash in the template does not describe the uploaded bytes. If you are seeing this *with* this plugin, the signing step and the hashing step have got out of order — likely another plugin also rewriting artifacts on a later hook. Check your `plugins` list ordering.

### Lambda: `InvalidCodeSignatureException`

The function has an `Enforce` code-signing config and was handed an artifact it does not trust.

- **On a normal deploy:** the artifact was not signed by the pinned profile version. Most often the signing profile was rotated, or you have per-environment profiles and deployed an artifact signed for a different one.
- **On a manual `update-function-code`:** working as designed. This is the protection doing its job.

### Lambda: `CodeVerificationFailedException`

The signature is present but does not validate — a corrupted or tampered artifact. Re-deploy from a clean `.serverless/`.

### CloudFormation: `CodeSigningConfig cannot be deleted while in use`

A `CodeSigningConfig` is still attached to a function. This can appear when disabling the plugin — CloudFormation may try to delete the config before detaching it from every function.

If the stack wedges, detach manually and retry:

```bash
aws lambda delete-function-code-signing-config --function-name <name>
```

## The deploy log shows no signing lines

The deploy succeeds, functions are listed, but nothing in the output mentions
signing — not even a "disabled" line.

**Before 1.0.4 this was expected, and it was a bug in this plugin.** Serverless
log levels run `error` > `warning` > `notice` > `info` > `debug` with a default
threshold of `notice`, and every message the plugin emitted was `info` — below
the threshold, so visible only under `--verbose`. The only line that showed was
the `retain` warning, which sat above it. A deploy log like this was the result:

```
Deploying my-service to stage dev (us-east-1)
Warning: custom.signer.retain is accepted but ignored: ...
✔ Service deployed to stack my-service-dev (50s)
```

There was no way to tell from that log whether the artifacts were signed.

**Fix:** upgrade to 1.0.4 or later, where every message that answers "was this
signed, and with what?" is emitted at `notice`. See
[What the deploy log tells you](./how-it-works.md#what-the-deploy-log-tells-you).

If you are on 1.0.4+ and still see no signing lines, the plugin is genuinely not
running. Check, in order:

1. `serverless-aws-code-signer` is in the `plugins:` list — if it were listed
   but misconfigured, the deploy would have failed, not gone quiet.
2. You are looking at the right service. In a multi-service pipeline the plugin
   is per-`serverless.yml`.
3. Another plugin is filtering the output.

## `N Lambda(s) generated by Serverless will deploy UNSIGNED because ...`

> `custom.signer.signCustomResources` is set to false: `<names>`. Remove that
> setting to sign them.

Not an error — a gap you opted into, which the plugin refuses to leave silent.

Certain events make Serverless inject a Lambda of its own: an `s3` event with
`existing: true`, `eventBridge`, an existing `cognitoUserPool`, or the API
Gateway CloudWatch role. They run code in your account with IAM permissions to
reconfigure buckets and event sources, so they are signed by default.

Delete `signCustomResources: false` from your config to close the gap. There is
no way to silence the warning while leaving those functions unsigned, which is
the point — see [`signCustomResources`](./configuration.md#signcustomresources).

## `N Lambda(s) in this stack are NOT signed and cannot be by this plugin`

> ...because another plugin injected them and their artifacts are not ours to
> locate: `<names>`.

A third-party plugin — a warmer, a log subscriber, its own custom resource — put
a Lambda in your template. The plugin cannot find its artifact, so it cannot
sign it, and it will not attach an `Enforce` policy to a function whose zip was
never signed: that converts a coverage gap into a broken deploy without making
anything more secure.

Your options, in order of preference:

1. **Check whether the plugin needs to be there.** Some inject Lambdas you are
   not using.
2. **Sign it at its source** — if the plugin exposes its artifact path, sign it
   in your own hook before `before:package:finalize`.
3. **Accept it as out of scope**, knowing the deploy log names it every time.

The warning cannot be suppressed. That is deliberate: an unsigned Lambda in a
stack you believe is fully signed is exactly the thing worth knowing about.

## `N container-image function(s) carry no code-signing config`

Informational, and not fixable here. AWS Signer signs zip artifacts; a function
with `PackageType: Image` cannot carry a `CodeSigningConfigArn` at all. The
equivalent control for images is
[ECR image signing](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-signing.html),
a separate mechanism outside this plugin's scope.

## `The template contains Serverless-generated custom-resource Lambdas but ... does not exist`

The compiled template contains Serverless-generated custom-resource functions
and signing is enabled for them (the default), but `.serverless/custom-resources.zip` is not on disk, so
there is nothing to sign. The plugin fails rather than attaching an `Enforce`
policy to a function whose artifact was never signed — that would only move the
failure to CloudFormation.

This should not happen in a normal deploy: Serverless writes the zip before it
injects the functions that use it. If you hit it, the likely causes are a
custom `package` path, a plugin that cleans `.serverless/` mid-deploy, or a
Serverless version whose custom-resource internals differ from what this plugin
expects. Open an issue with your Serverless version.

## Still stuck?

Run with `--verbose` for the plugin's debug output, which includes signing job polling status.

Open an issue at [github.com/noun-phireak/serverless-aws-code-signer/issues](https://github.com/noun-phireak/serverless-aws-code-signer/issues) with the error, your `custom.signer` block (redact bucket and profile names), and your Serverless version.

> **Found a security problem rather than a bug?** Do not open a public issue. Follow the [security policy](../SECURITY.md) to report it privately.
