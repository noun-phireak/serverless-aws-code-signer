# Getting started

This walks through the AWS prerequisites, installing the plugin, and confirming that the bytes Lambda runs are actually the bytes AWS Signer signed.

## Prerequisites

The plugin **never creates infrastructure**. Both of the following must exist before your first deploy, or the deploy fails with a clear error.

### 1. An AWS Signer profile

The profile must use the `AWSLambda-SHA384-ECDSA` signing platform and be in the **same account and region** as the deploy.

```bash
aws signer put-signing-profile \
  --profile-name my-signing-profile \
  --platform-id AWSLambda-SHA384-ECDSA \
  --region us-east-1
```

In a real environment this belongs in Terraform or whatever your SRE team uses — the point of the plugin refusing to create it is that a signing profile is a trust root, and trust roots should not be minted as a side effect of someone's `serverless deploy`.

Confirm it is `Active`:

```bash
aws signer get-signing-profile --profile-name my-signing-profile
```

A profile in any other status (`Canceled`, `Revoked`) is rejected.

### 2. A versioning-enabled S3 bucket

AWS Signer reads its source object by version ID, so **versioning is mandatory**. The plugin checks for a `VersionId` on upload and fails with an actionable error if the bucket is unversioned.

```bash
aws s3api create-bucket --bucket my-artifacts-bucket --region us-east-1
aws s3api put-bucket-versioning \
  --bucket my-artifacts-bucket \
  --versioning-configuration Status=Enabled
```

One bucket is enough — signed artifacts are written back to the source bucket unless you configure a separate `destination`.

### 3. Deploy-role permissions

See [Configuration → IAM](./configuration.md#iam-permissions) for the full policy.

## Install

```bash
npm install --save-dev serverless-aws-code-signer
```

## Configure

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

Those three values are the only required ones. Everything else — the signing policy, the timeout, the destination bucket — has a secure default. See [Configuration](./configuration.md) for the full list.

## Deploy

```bash
serverless deploy
```

You will see a line per artifact:

```
Signing 3 artifact(s) with profile "my-signing-profile" (policy Enforce)
Signed api.zip (2847213 bytes, CodeSha256 K7pQ..., job 9f3c1b2a-...)
```

## Verify it worked

Three independent checks, in increasing order of rigour.

### The CodeSha256 matches

The `CodeSha256` in the deploy log is the SHA-256 of the signed bytes, base64-encoded. Compare it against what Lambda reports:

```bash
aws lambda get-function-configuration \
  --function-name my-service-dev-api \
  --query CodeSha256 --output text
```

These must be identical. This is the check that the plugin exists to make possible — signing happens *before* the framework hashes the zip, so `AWS::Lambda::Version.CodeSha256` describes the bytes that actually reach Lambda.

### The function has a code-signing config attached

```bash
aws lambda get-function-code-signing-config \
  --function-name my-service-dev-api
```

This returns a `CodeSigningConfigArn`. If it returns nothing, the CloudFormation half did not run — see [How it works](./how-it-works.md).

### Unsigned code is actually rejected

The real test. With the default `signingPolicy: Enforce`, pushing an unsigned zip directly to the function must fail:

```bash
aws lambda update-function-code \
  --function-name my-service-dev-api \
  --zip-file fileb://some-unsigned.zip
```

Expect `InvalidCodeSignatureException`. If this *succeeds*, your functions are not actually protected — check that the policy is `Enforce` and not `Warn`.

## Next steps

- [Configuration](./configuration.md) — every option, per-stage toggling, IAM
- [How it works](./how-it-works.md) — the lifecycle hooks and template changes
- [Troubleshooting](./troubleshooting.md) — every error and its fix
- [Security policy](../SECURITY.md) — threat model, and what signing does not protect against
