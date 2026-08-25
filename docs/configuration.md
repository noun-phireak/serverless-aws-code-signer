# Configuration

Everything lives under `custom.signer` in `serverless.yml`.

## Full reference

| Option | Type | Default | Required |
| --- | --- | --- | --- |
| `profileName` | string | — | Yes, when enabled |
| `source.s3.bucketName` | string | — | Yes, when enabled |
| `source.s3.prefix` | string | `''` | No |
| `destination.s3.bucketName` | string | same as `source.s3.bucketName` | No |
| `destination.s3.prefix` | string | `''` | No |
| `enabled` | boolean \| `"true"` \| `"false"` | `true` | No |
| `signingPolicy` | `Enforce` \| `Warn` | `Enforce` | No |
| `timeoutSeconds` | number | `300` | No |
| `signCustomResources` | boolean \| `"true"` \| `"false"` | `true` | No |
| `retain` | boolean | — | No (accepted, ignored) |

The config is validated against a JSON schema with `additionalProperties: false`, so a **typo in an option name is a hard error**, not a silently ignored key.

## Minimal config

```yaml
custom:
  signer:
    profileName: my-signing-profile
    source:
      s3:
        bucketName: my-artifacts-bucket
```

## Options in detail

### `profileName`

The name of an existing AWS Signer profile in the same account and region as the deploy. The plugin resolves it to a `profileVersionArn` — pinning the exact profile *version* that signed the code, not just the profile.

The plugin will **not** create a missing profile. A typo fails the deploy. See [Design principles](../README.md#design-principles) for why.

### `source.s3`

Where artifacts are staged for AWS Signer to read. **The bucket must have versioning enabled** — Signer addresses its input by version ID.

Each artifact is staged under a unique key so concurrent deploys cannot collide:

```
<prefix><functionName>-<timestamp>-<uuid>
```

`prefix` is used verbatim, so include the trailing slash if you want a folder:

```yaml
source:
  s3:
    bucketName: my-artifacts-bucket
    prefix: signing/staging/     # note the trailing slash
```

Staged objects are **not** cleaned up by the plugin. Set an S3 lifecycle rule on the prefix to expire them — a few days is plenty, since they are only an input to the signing job:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-artifacts-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-signer-staging",
      "Status": "Enabled",
      "Filter": {"Prefix": "signing/staging/"},
      "Expiration": {"Days": 7},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 7}
    }]
  }'
```

Because the bucket is versioned, expiring current versions is not enough — `NoncurrentVersionExpiration` is what actually reclaims the storage.

### `destination.s3`

Where AWS Signer writes the signed artifact. Defaults to the source bucket, which is usually what you want. Specify it only if you want signed output segregated — for example, a bucket with stricter access controls or a longer retention policy:

```yaml
destination:
  s3:
    bucketName: my-signed-artifacts
    prefix: signed/
```

If `destination.s3.bucketName` is set and differs from the source, the plugin checks that bucket exists too, before signing anything.

Signed objects also accumulate. They are the auditable record of what you shipped, so retention here is a compliance decision rather than a cleanup chore — but decide it deliberately.

### `enabled`

Controls whether signing runs. Defaults to `true`: listing the plugin means you want signing.

Accepts a real boolean, or the strings `"true"` / `"false"` (case-insensitive, trimmed) so that Serverless variables work:

```yaml
custom:
  signer:
    enabled: ${self:custom.signingByStage.${sls:stage}, 'false'}
    profileName: my-signing-profile
    source:
      s3:
        bucketName: my-artifacts-bucket

  signingByStage:
    prod: 'true'
    staging: 'true'
```

An **unresolved `${...}` is a hard error**, not a truthy string. This is the single most important behaviour in the plugin: a signing plugin that cannot tell whether it is meant to run must never quietly pick an answer. Guessing "on" ships an unwanted signature; guessing "off" ships unsigned code.

Note the quoted `'false'` fallback in the example. An unquoted `false` in that position works too, but quoting keeps the intent obvious next to the string-valued map entries.

When disabled, the plugin logs that artifacts are being left unsigned, skips signing entirely, and adds nothing to the CloudFormation template. `profileName` and `source` are not validated in that case, so a stage that never signs does not need them configured.

> **Disabling does not remove protection from an already-deployed function.** It stops the plugin adding a `CodeSigningConfig` to the template, which on an existing stack means CloudFormation *detaches* it. The function stops rejecting unsigned code from that deploy onward.

### `signingPolicy`

Maps to `UntrustedArtifactOnDeployment` on the CloudFormation code-signing config.

| Value | Behaviour |
| --- | --- |
| `Enforce` (default) | Lambda **rejects** an unsigned or untrusted artifact |
| `Warn` | Lambda **accepts** it and logs a CloudTrail warning |

`Warn` is a migration aid — use it to find callers pushing unsigned code without breaking them, then switch to `Enforce`. `Warn` provides no actual protection; do not leave it there.

### `timeoutSeconds`

How long to wait for a signing job to reach a terminal state. Default `300` (5 minutes).

The plugin polls `DescribeSigningJob` with exponential backoff — 1s, doubling to a 10s ceiling. Signing a Lambda zip is normally seconds; the default has generous headroom. Raise it only if you have large artifacts and see timeout errors.

### `signCustomResources`

Also sign the Lambdas **Serverless generates for itself**, and attach the code-signing config to them. Default **`true`** — set it to `false` only to deliberately opt out.

If signing is on at all, every function this plugin *can* sign gets signed. A framework-injected Lambda left unsigned is a gap, not a default.

Some events make the framework inject its own Lambda into your stack:

| What you wrote | What Serverless injects |
| --- | --- |
| an `s3` event with `existing: true` | `custom-resource-existing-s3` |
| an `eventBridge` event | `custom-resource-event-bridge` |
| a `cognitoUserPool` event with `existing: true` | `custom-resource-existing-cup` |
| any `http` event, first deploy in a region | `custom-resource-apigw-cw-role` |

For example, this makes Serverless add a Lambda whose job is to write the bucket notification configuration:

```yaml
functions:
  reportProcessor:
    handler: src/reports.handler
    events:
      - s3:
          bucket: ${self:custom.s3Bucket}
          event: s3:ObjectCreated:*
          rules:
            - prefix: clientUpload/reports/
          existing: true
```

Those Lambdas are not declared in your `serverless.yml`, so by default the plugin leaves them alone — but they do run code in your account, holding IAM permissions to reconfigure buckets and event sources. If your reason for signing is supply-chain assurance, that is a real gap: anyone who can write to your deployment bucket can swap that artifact for their own.

This is handled automatically — no configuration needed. All of the framework's custom resources share **one** artifact, `.serverless/custom-resources.zip`, so it costs exactly one extra signing job per deploy regardless of how many such events a service has.

If you opt out, the plugin **names** the affected functions on every deploy rather than going quiet:

```yaml
custom:
  signer:
    signCustomResources: false     # deliberate opt-out
```

```
Warning: 1 Lambda(s) generated by Serverless will deploy UNSIGNED because
`custom.signer.signCustomResources` is set to false: svc-dev-custom-resource-existing-s3.
Remove that setting to sign them.
```

There is no way to silence that warning while leaving those functions unsigned. That is the point.

> **Note:** this covers the Lambdas *Serverless itself* generates, identified by the artifact they run. Lambdas injected by **third-party plugins** (warmers, log subscribers, custom resources of their own) cannot be signed by this plugin — it cannot locate their artifacts — but they are [reported by name](#coverage-accounting) rather than ignored.

### `retain`

Accepted and **deliberately ignored**. This plugin never creates signing profiles or buckets, so it has nothing to retain. It is allowed in the schema so that configs carried over from other signing plugins do not trip the `additionalProperties: false` check. You can delete it whenever convenient.

## Coverage accounting

Once signing is enabled, the intent is that **every function in the stack is signed**. Anything this plugin cannot cover is named in the deploy log rather than skipped quietly, so the claim is verifiable instead of assumed.

Every `AWS::Lambda::Function` in the compiled template lands in exactly one of these:

| Category | Covered? | How it is reported |
| --- | --- | --- |
| Declared in your `serverless.yml` | **Signed** | counted in the `Attached CodeSigningConfig` line |
| Generated by Serverless (`existing: true`, EventBridge, Cognito, APIGW CloudWatch role) | **Signed** by default | counted in the same line |
| Generated by Serverless, with `signCustomResources: false` | No | **warning**, listed by name |
| Injected by a third-party plugin | No — artifact not locatable | **warning**, listed by name |
| Container-image functions (`PackageType: Image`) | Not applicable | **notice**, listed by name |

Container images are not a gap this plugin can close: AWS Signer signs zip artifacts, and image signing is [ECR image signing](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-signing.html), a separate mechanism.

For third-party plugin Lambdas, the plugin will not attach an `Enforce` policy to a function whose artifact it never signed — that converts a coverage gap into a broken deploy without making anything more secure. Sign them at their source, or accept them as out of scope; either way, the deploy log now names them.

## Per-stage configuration

The most common pattern — sign in production, skip locally:

```yaml
custom:
  signer:
    enabled: ${self:custom.signerEnabled.${sls:stage}, 'false'}
    profileName: ${self:custom.signerProfile.${sls:stage}, ''}
    signingPolicy: ${self:custom.signerPolicy.${sls:stage}, 'Enforce'}
    source:
      s3:
        bucketName: ${self:custom.signerBucket.${sls:stage}, ''}
        prefix: signing/${sls:stage}/

  signerEnabled:
    prod: 'true'
    staging: 'true'
  signerProfile:
    prod: prod-signing-profile
    staging: staging-signing-profile
  signerBucket:
    prod: prod-artifacts
    staging: staging-artifacts
  signerPolicy:
    staging: 'Warn'
```

The empty-string fallbacks are only ever read on stages where `enabled` is false, and disabled stages skip validation entirely.

Use **separate profiles per environment**. A shared profile means a staging deploy produces an artifact that production will accept as trusted.

## IAM permissions

The identity running `serverless deploy` needs the following. Scope the resource ARNs to your actual profile and buckets — the wildcards below are for readability.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignerJobs",
      "Effect": "Allow",
      "Action": [
        "signer:GetSigningProfile",
        "signer:StartSigningJob",
        "signer:DescribeSigningJob"
      ],
      "Resource": "arn:aws:signer:us-east-1:123456789012:/signing-profiles/my_signing_profile"
    },
    {
      "Sid": "StageAndRetrieveArtifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::my-artifacts-bucket/*"
    },
    {
      "Sid": "ConfirmBucketsExist",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-artifacts-bucket"
    },
    {
      "Sid": "CodeSigningConfigLifecycle",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateCodeSigningConfig",
        "lambda:UpdateCodeSigningConfig",
        "lambda:GetCodeSigningConfig",
        "lambda:DeleteCodeSigningConfig",
        "lambda:PutFunctionCodeSigningConfig",
        "lambda:GetFunctionCodeSigningConfig"
      ],
      "Resource": "*"
    }
  ]
}
```

Notes:

- **`s3:ListBucket`, not `s3:HeadBucket`.** There is no such IAM action as `s3:HeadBucket`; the `HeadBucket` API call is authorized by `s3:ListBucket` on the *bucket* ARN (no `/*`). Missing this is the usual cause of the "No permission to access S3 bucket" error.
- **Signer profile ARNs use underscores.** Signer profile names allow only alphanumerics and underscores, so a profile named `my_signing_profile` has ARN path `/signing-profiles/my_signing_profile`.
- **If you use a separate destination bucket**, add `s3:GetObject` on it and `s3:ListBucket` on the bucket itself.
- **`lambda:*CodeSigningConfig` needs `Resource: "*"`** for the create call, since the ARN does not exist yet at that point.
- These are the permissions the *plugin and CloudFormation* need, on top of whatever your normal Serverless deploy role already has.

## Scope

Supported: `package.individually: true` and single-artifact packaging, `serverless deploy`, `serverless deploy function`, per-stage enable/disable, container-image functions (skipped, not an error), Serverless-generated custom-resource Lambdas (signed by default, see [`signCustomResources`](#signcustomresources)).

Not implemented: Lambda layer signing, signing Lambdas injected by third-party plugins, a standalone `serverless signer` CLI command.
