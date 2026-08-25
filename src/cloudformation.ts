import type { SigningPolicy } from './types';

export const CODE_SIGNING_CONFIG_LOGICAL_ID = 'CodeSigningConfig';

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * Add one CodeSigningConfig and point every user function at it.
 *
 * One shared config, not one per function. Creating a resource per function and
 * then pointing every function at the last one leaves N-1 orphans in the
 * template. One shared config is both correct and cheaper.
 */
export function applyCodeSigningConfig(
  resources: Record<string, CfnResource>,
  options: {
    profileVersionArn: string;
    signingPolicy: SigningPolicy;
    serviceName: string;
    userFunctionNames: Set<string>;
  }
): void {
  resources[CODE_SIGNING_CONFIG_LOGICAL_ID] = {
    Type: 'AWS::Lambda::CodeSigningConfig',
    Properties: {
      Description: `Managed by serverless-aws-code-signer for ${options.serviceName}`,
      AllowedPublishers: { SigningProfileVersionArns: [options.profileVersionArn] },
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: options.signingPolicy },
    },
  };

  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const properties = resource.Properties;
    if (!properties) continue;
    // Container-image functions cannot carry a CodeSigningConfigArn.
    if (properties.PackageType === 'Image') continue;
    if (!options.userFunctionNames.has(properties.FunctionName as string)) continue;

    properties.CodeSigningConfigArn = { Ref: CODE_SIGNING_CONFIG_LOGICAL_ID };
  }
}
