/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createLegacyAuthAdapters } from '@backstage/backend-common';
import {
  AuthService,
  BackstageCredentials,
  DiscoveryService,
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { CatalogApi } from '@backstage/catalog-client';
import {
  Entity,
  CompoundEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { Config } from '@backstage/config';

/** @public */
export interface JenkinsInfoProvider {
  getInstance(options: {
    /**
     * The entity to get the info about.
     */
    entityRef: CompoundEntityRef;
    /**
     * A specific job to get. This is only passed in when we know about a job name we are interested in.
     */
    jobFullName?: string;

    credentials?: BackstageCredentials;
    logger?: LoggerService;
  }): Promise<JenkinsInfo>;
}

/** @public */
export interface JenkinsInfo {
  baseUrl: string;
  headers?: Record<string, string | string[]>;
  jobFullName: string; // TODO: make this an array
  projectCountLimit: number;
  crumbIssuer?: boolean;
}

/** @public */
export interface JenkinsInstanceConfig {
  name: string;
  baseUrl: string;
  username: string;
  projectCountLimit?: number;
  apiKey: string;
  crumbIssuer?: boolean;
  /**
   * Extra headers to send to Jenkins instance
   */
  extraRequestHeaders?: Record<string, string>;
  /**
   * Set a list of compatible regex strings for the url
   */
  allowedBaseUrlOverrideRegex?: string;
}

/**
 * Holds multiple Jenkins configurations.
 *
 * @public
 */
export class JenkinsConfig {
  constructor(public readonly instances: JenkinsInstanceConfig[]) {}

  /**
   * Read all Jenkins instance configurations.
   * @param config - Root configuration
   * @returns A JenkinsConfig that contains all configured Jenkins instances.
   */
  static fromConfig(config: Config): JenkinsConfig {
    const DEFAULT_JENKINS_NAME = 'default';

    const jenkinsConfig = config.getConfig('jenkins');

    // load all named instance config
    const namedInstanceConfig: JenkinsInstanceConfig[] =
      jenkinsConfig.getOptionalConfigArray('instances')?.map(c => ({
        name: c.getString('name'),
        baseUrl: c.getString('baseUrl'),
        username: c.getString('username'),
        projectCountLimit: c.getOptionalNumber('projectCountLimit'),
        apiKey: c.getString('apiKey'),
        extraRequestHeaders: c.getOptional('extraRequestHeaders'),
        crumbIssuer: c.getOptionalBoolean('crumbIssuer'),
        allowedBaseUrlOverrideRegex: c.getOptionalString(
          'allowedBaseUrlOverrideRegex',
        ),
      })) || [];

    // load unnamed default config
    const hasNamedDefault = namedInstanceConfig.some(
      x => x.name === DEFAULT_JENKINS_NAME,
    );

    // Get these as optional strings and check to give a better error message
    const baseUrl = jenkinsConfig.getOptionalString('baseUrl');
    const username = jenkinsConfig.getOptionalString('username');
    const apiKey = jenkinsConfig.getOptionalString('apiKey');
    const crumbIssuer = jenkinsConfig.getOptionalBoolean('crumbIssuer');
    const extraRequestHeaders = jenkinsConfig.getOptional<
      JenkinsInstanceConfig['extraRequestHeaders']
    >('extraRequestHeaders');
    const allowedBaseUrlOverrideRegex = jenkinsConfig.getOptionalString(
      'allowedBaseUrlOverrideRegex',
    );

    if (hasNamedDefault && (baseUrl || username || apiKey)) {
      throw new Error(
        `Found both a named jenkins instance with name ${DEFAULT_JENKINS_NAME} and top level baseUrl, username or apiKey config. Use only one style of config.`,
      );
    }

    const unnamedNonePresent = !baseUrl && !username && !apiKey;
    const unnamedAllPresent = baseUrl && username && apiKey;
    if (!(unnamedAllPresent || unnamedNonePresent)) {
      throw new Error(
        `Found partial default jenkins config. All (or none) of baseUrl, username and apiKey must be provided.`,
      );
    }

    if (unnamedAllPresent) {
      return new JenkinsConfig([
        ...namedInstanceConfig,
        {
          name: DEFAULT_JENKINS_NAME,
          baseUrl,
          username,
          apiKey,
          extraRequestHeaders,
          crumbIssuer,
          allowedBaseUrlOverrideRegex,
        },
      ]);
    }

    return new JenkinsConfig(namedInstanceConfig);
  }

  /**
   * Gets a Jenkins instance configuration by name, or the default one if no
   * name is provided.
   * @param jenkinsName - Optional name of the Jenkins instance.
   * @returns The requested Jenkins instance.
   */
  getInstanceConfig(jenkinsName?: string): JenkinsInstanceConfig {
    const DEFAULT_JENKINS_NAME = 'default';

    if (!jenkinsName || jenkinsName === DEFAULT_JENKINS_NAME) {
      // no name provided, use default
      const instanceConfig = this.instances.find(
        c => c.name === DEFAULT_JENKINS_NAME,
      );

      if (!instanceConfig) {
        throw new Error(
          `Couldn't find a default jenkins instance in the config. Either configure an instance with name ${DEFAULT_JENKINS_NAME} or add a prefix to your annotation value.`,
        );
      }

      return instanceConfig;
    }

    // A name is provided, look it up.
    const instanceConfig = this.instances.find(c => c.name === jenkinsName);

    if (!instanceConfig) {
      throw new Error(
        `Couldn't find a jenkins instance in the config with name ${jenkinsName}`,
      );
    }
    return instanceConfig;
  }
}

/**
 * Use default config and annotations, build using fromConfig static function.
 *
 * This will fallback through various deprecated config and annotation schemes.
 *
 * @public
 */
export class DefaultJenkinsInfoProvider implements JenkinsInfoProvider {
  static readonly OLD_JENKINS_ANNOTATION = 'jenkins.io/github-folder';
  static readonly NEW_JENKINS_ANNOTATION = 'jenkins.io/job-full-name';
  static readonly JENKINS_OVERRIDE_URL = 'jenkins.io/override-base-url';

  private constructor(
    private readonly config: JenkinsConfig,
    private readonly catalog: CatalogApi,
    private readonly auth: AuthService,
    private logger: LoggerService,
  ) {}

  static fromConfig(options: {
    config: Config;
    catalog: CatalogApi;
    discovery: DiscoveryService;
    auth?: AuthService;
    httpAuth?: HttpAuthService;
    logger: LoggerService;
  }): DefaultJenkinsInfoProvider {
    const { auth } = createLegacyAuthAdapters(options);
    return new DefaultJenkinsInfoProvider(
      JenkinsConfig.fromConfig(options.config),
      options.catalog,
      auth,
      options.logger,
    );
  }

  async getInstance(opt: {
    entityRef: CompoundEntityRef;
    jobFullName?: string;
    credentials?: BackstageCredentials;
  }): Promise<JenkinsInfo> {
    // default limitation of projects
    const DEFAULT_LIMITATION_OF_PROJECTS = 50;

    // load entity
    const entity = await this.catalog.getEntityByRef(
      opt.entityRef,
      opt.credentials &&
        (await this.auth.getPluginRequestToken({
          onBehalfOf: opt.credentials,
          targetPluginId: 'catalog',
        })),
    );
    if (!entity) {
      throw new Error(
        `Couldn't find entity with name: ${stringifyEntityRef(opt.entityRef)}`,
      );
    }

    // lookup `[jenkinsName#]jobFullName` from entity annotation
    const jenkinsAndJobName =
      DefaultJenkinsInfoProvider.getEntityAnnotationValue(entity);
    if (!jenkinsAndJobName) {
      throw new Error(
        `Couldn't find jenkins annotation (${
          DefaultJenkinsInfoProvider.NEW_JENKINS_ANNOTATION
        }) on entity with name: ${stringifyEntityRef(opt.entityRef)}`,
      );
    }

    let jobFullName;
    let jenkinsName: string | undefined;
    const splitIndex = jenkinsAndJobName.indexOf(':');
    if (splitIndex === -1) {
      // no jenkinsName specified, use default
      jobFullName = jenkinsAndJobName;
    } else {
      // There is a jenkinsName specified
      jenkinsName = jenkinsAndJobName.substring(0, splitIndex);
      jobFullName = jenkinsAndJobName.substring(
        splitIndex + 1,
        jenkinsAndJobName.length,
      );
    }

    // lookup baseURL + creds from config
    const instanceConfig = this.config.getInstanceConfig(jenkinsName);

    // override baseURL if config has override set to true
    const overrideUrlValue =
      DefaultJenkinsInfoProvider.getEntityOverrideURL(entity);
    if (
      instanceConfig.allowedBaseUrlOverrideRegex &&
      overrideUrlValue &&
      DefaultJenkinsInfoProvider.verifyUrlMatchesRegex(
        overrideUrlValue,
        instanceConfig.allowedBaseUrlOverrideRegex,
        this.logger,
      )
    ) {
      instanceConfig.baseUrl = overrideUrlValue;
    }

    const creds = Buffer.from(
      `${instanceConfig.username}:${instanceConfig.apiKey}`,
      'binary',
    ).toString('base64');

    return {
      baseUrl: instanceConfig.baseUrl,
      headers: {
        Authorization: `Basic ${creds}`,
        ...instanceConfig.extraRequestHeaders,
      },
      jobFullName,
      projectCountLimit:
        instanceConfig.projectCountLimit ?? DEFAULT_LIMITATION_OF_PROJECTS,
      crumbIssuer: instanceConfig.crumbIssuer,
    };
  }

  private static getEntityAnnotationValue(entity: Entity) {
    return (
      entity.metadata.annotations?.[
        DefaultJenkinsInfoProvider.OLD_JENKINS_ANNOTATION
      ] ||
      entity.metadata.annotations?.[
        DefaultJenkinsInfoProvider.NEW_JENKINS_ANNOTATION
      ]
    );
  }

  private static getEntityOverrideURL(entity: Entity) {
    return entity.metadata.annotations?.[
      DefaultJenkinsInfoProvider.JENKINS_OVERRIDE_URL
    ];
  }

  private static verifyUrlMatchesRegex(
    url: string,
    regexString: string,
    logger: LoggerService,
  ) {
    try {
      const regex = new RegExp(regexString);
      if (regex.test(url)) {
        return true;
      }
    } catch (e: any) {
      logger.warn(`Invalid regex: "${regexString}" - Error: ${e.message}`);
    }
    return false;
  }
}
