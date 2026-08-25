# Migrating from `@ioiotv/serverless-aws-signer`

This plugin is a drop-in replacement at the config level: the `custom.signer` block you already have should work unchanged. What differs is the behaviour — mostly in cases the vendor plugin handled by guessing.

## The swap

```bash
npm uninstall @ioiotv/serverless-aws-signer
npm install --save-dev serverless-aws-code-signer
```

```diff
 plugins:
-  - '@ioiotv/serverless-aws-signer'
+  - serverless-aws-code-signer
```

Your `custom.signer` block stays as it is. The `retain` option is still accepted so it does not trip schema validation, though this plugin ignores it — see [below](#retain-is-accepted-and-ignored).

**Do not deploy straight to production.** Read the next two sections first; there is one CloudFormation change worth seeing in a `serverless package --stage prod` diff before it happens for real.

## Behaviour changes to expect

### 1. It will not create signing profiles or buckets

The vendor plugin created a missing signing profile for you. This one fails the deploy.

If you were relying on that — even accidentally — your first deploy will fail with:

> Signing profile "..." does not exist in this account/region. Create it out-of-band (Terraform/SRE) and re-run — this plugin will not create it.

**Before migrating**, confirm your profile already exists in every region and account you deploy to:

```bash
aws signer list-signing-profiles --region <region>
```

The reasoning: a typo in `profileName` that silently mints a fresh, unreviewed profile produces a deploy that *looks* signed and passes every check, while the trust root is something nobody approved. That defeats the entire point of code signing. A signing profile is a trust root, and trust roots should be created deliberately — in Terraform, or by whoever owns your security baseline.

### 2. One `CodeSigningConfig` resource instead of N

The vendor plugin created one `AWS::Lambda::CodeSigningConfig` **per function**, but attached the last one to all of them from inside the same loop — leaving N−1 orphaned resources in the template, paid for and doing nothing.

This plugin creates a single config with logical ID `CodeSigningConfig` and points every function at it.

**This is a real CloudFormation change.** On your first deploy after migrating, CloudFormation will delete the old per-function config resources and create one new one. Functions are re-pointed at the new config in the same changeset.

Preview it before deploying:

```bash
serverless package --stage prod
# inspect .serverless/cloudformation-template-update-stack.json
```

If the stack wedges on deleting a config still attached to a function, see [Troubleshooting](./troubleshooting.md#cloudformation-codesigningconfig-cannot-be-deleted-while-in-use).

### 3. `enabled` is evaluated after variables resolve

The vendor plugin decided whether to run inside its **constructor**, which executes before Serverless has finished resolving variables. An unresolved `${...}` is a truthy string, so the flag could not be trusted in either direction.

This plugin registers its hooks unconditionally and reads `enabled` inside them, once variables have resolved. Two consequences:

- **An unresolved variable is now a hard error**, not silently `true`. If `enabled: ${self:custom.signerEnabled.${sls:stage}}` has no fallback and the stage key is missing, you will now find out. Add a fallback: `${self:custom.signerEnabled.${sls:stage}, 'false'}`.
- **A stage you believed was not signing may start signing** — if `enabled` was an unresolved variable that the vendor plugin read as truthy, it was signing there too, and this plugin will now tell you what it actually resolves to rather than what it happened to coerce to.

Check what each stage resolves to before migrating:

```bash
serverless print --stage <stage> | grep -A6 'signer:'
```

### 4. Missing config is an error

If the plugin is in `plugins` but there is no `custom.signer`, the deploy fails rather than quietly skipping. Signing is not something to opt out of by omission — use `enabled: false` if you mean it.

### 5. The artifact truncation bug is fixed

The bug worth migrating for.

The vendor plugin wrote the signed artifact with the callback-style `fs.writeFile` and **passed no callback**. Because Serverless applies `graceful-fs`'s `gracefulify` to `fs`, that call returned immediately with the zip truncated to zero bytes. `package:compileFunctions` then hashed the empty file into `AWS::Lambda::Version.CodeSha256`, while the complete artifact was what actually got uploaded — producing a `CodeSha256` mismatch inside CloudFormation, far from its cause and with nothing in the log to point at it.

This plugin awaits the write, then reads the size back off disk and compares it. If a write ever silently misbehaves again, the deploy fails immediately with a precise message.

If you have been seeing intermittent, hard-to-reproduce `CodeSha256` mismatches on deploy, this was very likely the cause.

### 6. More is validated, earlier

Checks the vendor plugin did not make, all of which fail the deploy rather than producing a broken artifact:

| Check | Error |
| --- | --- |
| Source bucket versioning | Missing `VersionId` on upload is caught with an actionable message |
| Profile status | A `Canceled`/`Revoked` profile is rejected, not used |
| Empty input artifact | Refuses to sign a zero-byte zip |
| Empty signed artifact | Refuses to ship a zero-byte result |
| Written size | Verified against the bytes written |

All of the environment checks (profile, buckets) run **once, before any artifact is touched**, so a misconfigured profile fails before half your functions have been signed.

### 7. Container-image functions are skipped, not failed

Functions with `image` are skipped during signing, and never get a `CodeSigningConfigArn` — the property is not valid on `PackageType: Image`. Mixed zip/image services work without special handling.

### 8. Only your functions get a code-signing config

`CodeSigningConfigArn` is applied only to functions declared in your `serverless.yml`, matched by `FunctionName`. Lambdas injected into the template by other plugins — custom resources, log subscribers, warmers — are left alone.

## `retain` is accepted and ignored

The vendor plugin's `retain` option controlled whether it kept resources it had created. Since this plugin never creates a signing profile or a bucket, there is nothing to retain.

It stays in the schema so that migrating configs do not trip the `additionalProperties: false` validation. You can delete it whenever convenient.

## Suggested migration path

1. **Verify prerequisites exist** — signing profile `Active`, source bucket versioned, in every target account and region.
2. **Check IAM.** This plugin calls `HeadBucket`, which the vendor plugin may not have. That needs `s3:ListBucket` on the bucket ARN. See [IAM permissions](./configuration.md#iam-permissions).
3. **Swap the dependency and the `plugins` entry.**
4. **Confirm every stage resolves as you expect** — `serverless print --stage <stage>`. Fix any variable without a fallback.
5. **Diff the template** — `serverless package` and inspect the code-signing resources.
6. **Deploy to a non-production stage.** Verify with the checks in [Getting started](./getting-started.md#verify-it-worked), especially that unsigned code is actually rejected.
7. **Deploy to production.**

## Rolling back

Reverse the swap. Since the config shape is compatible, no `serverless.yml` change is needed beyond the `plugins` entry.

Rolling back re-creates the per-function config resources, so it is another CloudFormation change rather than a no-op — worth knowing before you need it in a hurry.
