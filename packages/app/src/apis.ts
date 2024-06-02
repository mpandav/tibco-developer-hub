import {
  ScmIntegrationsApi,
  scmIntegrationsApiRef,
  ScmAuth,
} from '@backstage/integration-react';
import { GithubAuth } from '@backstage/core-app-api';
import {
  AnyApiFactory,
  configApiRef,
  createApiFactory,
  createApiRef,
  discoveryApiRef,
  oauthRequestApiRef,
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
  ApiRef,
  githubAuthApiRef,
  identityApiRef,
} from '@backstage/core-plugin-api';

import { OAuth2 } from '@backstage/core-app-api';
import {
  apiDocsModuleWsdlApiRef,
  ApiDocsModuleWsdlClient,
  wsdlApiWidget,
} from '@dweber019/backstage-plugin-api-docs-module-wsdl';

import { ApiEntity } from '@backstage/catalog-model';


import { apiDocsConfigRef, defaultDefinitionWidgets } from '@backstage/plugin-api-docs';

export const tibcoOIDCAuthApiRef: ApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
> = createApiRef({
  id: 'auth.tibco',
});

export const apis: AnyApiFactory[] = [
  createApiFactory({
    api: scmIntegrationsApiRef,
    deps: { configApi: configApiRef },
    factory: ({ configApi }) => ScmIntegrationsApi.fromConfig(configApi),
  }),
  createApiFactory({
    api: tibcoOIDCAuthApiRef,
    deps: {
      discoveryApi: discoveryApiRef,
      oauthRequestApi: oauthRequestApiRef,
      configApi: configApiRef,
    },
    factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
      OAuth2.create({
        discoveryApi,
        oauthRequestApi,
        provider: {
          id: 'tibco',
          title: 'TIBCO authentication provider',
          icon: () => null,
        },
        environment: configApi.getOptionalString('auth.environment'),
        defaultScopes: ['openid', 'profile', 'email'],
      }),
  }),
  createApiFactory({
    api: githubAuthApiRef,
    deps: {
      discoveryApi: discoveryApiRef,
      oauthRequestApi: oauthRequestApiRef,
    },
    factory: ({ discoveryApi, oauthRequestApi }) =>
      GithubAuth.create({
        discoveryApi,
        oauthRequestApi,
        defaultScopes: ['read:user', 'read:org'],
      }),
  }),
  ScmAuth.createDefaultApiFactory(),

  createApiFactory({
    api: apiDocsModuleWsdlApiRef,
    deps: {
      identityApi: identityApiRef,
      discoveryApi: discoveryApiRef,
    },
    factory: ({ identityApi, discoveryApi }) =>
      new ApiDocsModuleWsdlClient({ identityApi, discoveryApi }),
  }),
  createApiFactory({
    api: apiDocsConfigRef,
    deps: {},
    factory: () => {
      // load the default widgets
      const definitionWidgets = defaultDefinitionWidgets();
      // add the wsdl-docs api widget to the definition widgets
      definitionWidgets.push(wsdlApiWidget);
      return {
        getApiDefinitionWidget: (apiEntity: ApiEntity) => {
          // find the widget for the type of api entity
          return definitionWidgets.find(d => d.type === apiEntity.spec.type);
        },
      };
    },
  })
  
];
