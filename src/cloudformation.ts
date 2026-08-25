import type { SigningPolicy } from './types';

export const CODE_SIGNING_CONFIG_LOGICAL_ID = 'CodeSigningConfig';

/**
 * The zip Serverless builds for its own custom-resource Lambdas.
 *
 * Events declared with `existing: true` (S3), plus EventBridge, Cognito user
 * pools and the API Gateway CloudWatch role, are wired up by Lambdas the
 * framework injects at `package:compileEvents`. All of them share this one
 * artifact, written to `<serviceDir>/.serverless/`.
 */
export const CUSTOM_RESOURCE_ARTIFACT_NAME = 'custom-resources.zip';

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * A full accounting of every AWS::Lambda::Function in the template.
 *
 * Every function lands in exactly one bucket. "We signed some things" is not a
 * useful answer for a code-signing plugin; "here is every function, and here is
 * why each one is or is not covered" is.
 */
export interface ApplyResult {
  /** Functions declared in serverless.yml that were pointed at the config. */
  userFunctions: number;
  /** Framework custom-resource functions that were pointed at the config. */
  customResourceFunctions: number;
  /** Framework custom-resource functions left out because the option is off. */
  skippedCustomResourceFunctions: string[];
  /** Container-image functions: AWS::Lambda cannot attach a config to these. */
  imageFunctions: string[];
  /** Lambdas from other plugins: no artifact this plugin can locate. */
  unsignableFunctions: string[];
}

/**
 * Is this one of the framework's own custom-resource Lambdas?
 *
 * Identified by the artifact it runs rather than by logical ID. The logical IDs
 * ("CustomDashresourceDashexistingDashs3LambdaFunction" and friends) are
 * framework internals that have changed shape before; the S3 key is the actual
 * invariant we care about, because it is the thing we sign.
 */
/** Best available human-readable name: the CFN FunctionName, else the logical ID. */
function displayName(logicalId: string, resource: CfnResource): string {
  const functionName = resource.Properties?.FunctionName;
  return typeof functionName === 'string' ? functionName : logicalId;
}

export function isFrameworkCustomResource(resource: CfnResource): boolean {
  const code = resource.Properties?.Code as { S3Key?: unknown } | undefined;
  const key = code?.S3Key;
  return typeof key === 'string' && key.endsWith(`/${CUSTOM_RESOURCE_ARTIFACT_NAME}`);
}

/**
 * Add one CodeSigningConfig and point every user function at it.
 *
 * One shared config, not one per function. Creating a resource per function and
 * then pointing every function at the last one leaves N-1 orphans in the
 * template. One shared config is both correct and cheaper.
 *
 * `includeCustomResources` extends this to the framework's own custom-resource
 * Lambdas, which are not declared in serverless.yml but do run code in your
 * account with IAM permissions to reconfigure buckets and event sources. It is
 * only correct to set once their shared artifact has actually been signed.
 *
 * Returns per-category counts, so the caller can say in the deploy log what was
 * covered and what was left out.
 */
export function applyCodeSigningConfig(
  resources: Record<string, CfnResource>,
  options: {
    profileVersionArn: string;
    signingPolicy: SigningPolicy;
    serviceName: string;
    userFunctionNames: Set<string>;
    includeCustomResources: boolean;
  }
): ApplyResult {
  resources[CODE_SIGNING_CONFIG_LOGICAL_ID] = {
    Type: 'AWS::Lambda::CodeSigningConfig',
    Properties: {
      Description: `Managed by serverless-aws-code-signer for ${options.serviceName}`,
      AllowedPublishers: { SigningProfileVersionArns: [options.profileVersionArn] },
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: options.signingPolicy },
    },
  };

  const result: ApplyResult = {
    userFunctions: 0,
    customResourceFunctions: 0,
    skippedCustomResourceFunctions: [],
    imageFunctions: [],
    unsignableFunctions: [],
  };

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const properties = resource.Properties;
    if (!properties) continue;

    // Container-image functions cannot carry a CodeSigningConfigArn at all.
    // AWS Signer does not cover images; that is ECR image signing, a different
    // mechanism outside this plugin's scope.
    if (properties.PackageType === 'Image') {
      result.imageFunctions.push(displayName(logicalId, resource));
      continue;
    }

    if (options.userFunctionNames.has(properties.FunctionName as string)) {
      properties.CodeSigningConfigArn = { Ref: CODE_SIGNING_CONFIG_LOGICAL_ID };
      result.userFunctions += 1;
      continue;
    }

    if (isFrameworkCustomResource(resource)) {
      if (!options.includeCustomResources) {
        result.skippedCustomResourceFunctions.push(displayName(logicalId, resource));
        continue;
      }
      properties.CodeSigningConfigArn = { Ref: CODE_SIGNING_CONFIG_LOGICAL_ID };
      result.customResourceFunctions += 1;
      continue;
    }

    // A Lambda some other plugin injected. Its artifact is not ours to find, so
    // it cannot be signed -- but it is named rather than ignored, so "is every
    // function in this stack signed?" is answerable from the deploy log.
    result.unsignableFunctions.push(displayName(logicalId, resource));
  }
  return result;
}
