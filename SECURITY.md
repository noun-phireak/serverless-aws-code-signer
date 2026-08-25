# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/noun-phireak/serverless-aws-code-signer/security/advisories/new). If that is unavailable to you, email **phireaknoun@gmail.com** with `SECURITY` in the subject line.

Please include:

- A description of the issue and why you believe it is a security problem
- Steps to reproduce, or a proof of concept
- The plugin version, Serverless Framework version, and Node.js version
- Any relevant `custom.signer` configuration — **redact bucket names, profile names, and account IDs**

### What to expect

| | |
| --- | --- |
| Acknowledgement | Within 5 working days |
| Initial assessment | Within 10 working days |
| Fix or mitigation plan | Communicated once the assessment is complete |

This is a small, single-maintainer project. Timelines are best-effort rather than contractual. If you have not heard back within the acknowledgement window, please send a follow-up — mail does occasionally go missing.

You will be credited in the release notes and the advisory unless you would rather not be.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | ✅ |

Only the latest minor version receives security fixes. This table will be updated as the project matures.

## Threat model

This plugin exists to make Lambda code signing enforceable, so it is worth being explicit about what it does and does not defend against.

### What the plugin protects

- **Artifact integrity through the deploy pipeline.** Signing runs before the framework hashes the zip, so `AWS::Lambda::Version.CodeSha256` describes the bytes that reach Lambda. A mismatch between what was signed and what was hashed fails the deploy rather than shipping silently.
- **Unsigned or untrusted code reaching Lambda**, via an `AWS::Lambda::CodeSigningConfig` with `UntrustedArtifactOnDeployment: Enforce`.
- **Ambiguous configuration.** Unresolved variables, missing config, inactive signing profiles, and unversioned source buckets are all hard errors. The plugin fails closed rather than guessing whether signing should run.
- **Accidental trust-root creation.** The plugin never creates a signing profile or an S3 bucket, so a typo cannot mint a fresh, unreviewed profile that satisfies the config.

### What the plugin does not protect

- **A compromised build environment.** If an attacker controls the machine or CI runner running `serverless deploy`, they can modify the artifact *before* signing. The signature then attests to malicious code, correctly. Code signing proves provenance, not innocence.
- **A compromised AWS identity.** Credentials able to call `StartSigningJob` against your profile can sign arbitrary artifacts. Scope the deploy role tightly — see [IAM permissions](./docs/configuration.md#iam-permissions).
- **`signingPolicy: Warn`.** This accepts untrusted artifacts and only logs. It is a migration aid, not a control.
- **Source and dependency integrity.** Signing attests to the zip you built. It says nothing about whether your dependencies are trustworthy.
- **Anything after deployment.** Runtime compromise, injected layers, and configuration drift are out of scope.

## Scope for reports

**In scope:**

- Any path by which the plugin ships an unsigned or unverified artifact while reporting success
- Any way to bypass the fail-closed configuration checks
- Leakage of credentials, signing material, or artifact contents into logs or error messages
- Vulnerabilities in the plugin's own dependency tree that are reachable through its code paths

**Out of scope:**

- Vulnerabilities in AWS Signer, S3, Lambda, or the Serverless Framework — report those to their respective maintainers
- Misconfiguration of your own AWS account, IAM policies, or bucket policies
- The documented consequences of `signingPolicy: Warn` or `enabled: false`
- Findings that require an already-compromised build host or AWS credentials

## Verifying what you installed

Releases from 1.0.0 onward are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which cryptographically links the published tarball to the commit and workflow run that built it.

Verify a local install:

```bash
npm audit signatures
```

The package page on npm also shows the source commit and build workflow for each published version. If a version lacks a provenance attestation, treat that as worth asking about.
