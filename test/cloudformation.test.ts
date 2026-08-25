import { describe, expect, it } from 'vitest';

import {
  applyCodeSigningConfig,
  CODE_SIGNING_CONFIG_LOGICAL_ID,
  type CfnResource,
} from '../src/cloudformation';

const build = (): Record<string, CfnResource> => ({
  MyFunctionLambdaFunction: {
    Type: 'AWS::Lambda::Function',
    Properties: { FunctionName: 'svc-myFunction' },
  },
  OtherFunctionLambdaFunction: {
    Type: 'AWS::Lambda::Function',
    Properties: { FunctionName: 'svc-otherFunction' },
  },
  ImageFunctionLambdaFunction: {
    Type: 'AWS::Lambda::Function',
    Properties: { FunctionName: 'svc-imageFunction', PackageType: 'Image' },
  },
  CustomInternalLambda: {
    Type: 'AWS::Lambda::Function',
    Properties: { FunctionName: 'svc-custom-resource-generated' },
  },
  SomeQueue: { Type: 'AWS::SQS::Queue', Properties: {} },
});

const options = {
  profileVersionArn: 'arn:aws:signer:us-east-1:1234:/signing-profiles/my-profile/ABC',
  signingPolicy: 'Enforce' as const,
  serviceName: 'svc',
  userFunctionNames: new Set(['svc-myFunction', 'svc-otherFunction', 'svc-imageFunction']),
};

describe('applyCodeSigningConfig', () => {
  it('adds exactly one code signing config', () => {
    const resources = build();
    applyCodeSigningConfig(resources, options);

    const configs = Object.values(resources).filter(
      (resource) => resource.Type === 'AWS::Lambda::CodeSigningConfig'
    );
    // One per function, all wired to the last one, would leave the rest
    // orphaned in the template.
    expect(configs).toHaveLength(1);
    expect(resources[CODE_SIGNING_CONFIG_LOGICAL_ID]?.Properties).toMatchObject({
      AllowedPublishers: { SigningProfileVersionArns: [options.profileVersionArn] },
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: 'Enforce' },
    });
  });

  it('attaches the config to user zip functions only', () => {
    const resources = build();
    applyCodeSigningConfig(resources, options);

    const ref = { Ref: CODE_SIGNING_CONFIG_LOGICAL_ID };
    expect(resources.MyFunctionLambdaFunction?.Properties?.CodeSigningConfigArn).toEqual(ref);
    expect(resources.OtherFunctionLambdaFunction?.Properties?.CodeSigningConfigArn).toEqual(ref);
  });

  it('skips container-image functions, which cannot carry the arn', () => {
    const resources = build();
    applyCodeSigningConfig(resources, options);
    expect(resources.ImageFunctionLambdaFunction?.Properties?.CodeSigningConfigArn).toBeUndefined();
  });

  it('skips lambdas serverless generated that are not user functions', () => {
    const resources = build();
    applyCodeSigningConfig(resources, options);
    expect(resources.CustomInternalLambda?.Properties?.CodeSigningConfigArn).toBeUndefined();
  });
});
