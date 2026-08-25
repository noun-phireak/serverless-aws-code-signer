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

## Still stuck?

Run with `--verbose` for the plugin's debug output, which includes signing job polling status.

Open an issue at [github.com/noun-phireak/serverless-aws-code-signer/issues](https://github.com/noun-phireak/serverless-aws-code-signer/issues) with the error, your `custom.signer` block (redact bucket and profile names), and your Serverless version.

> **Found a security problem rather than a bug?** Do not open a public issue. Follow the [security policy](../SECURITY.md) to report it privately.
