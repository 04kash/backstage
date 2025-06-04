/*
 * Copyright 2024 The Backstage Authors
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

import type {
  DiscoveryService,
  LoggerService,
  SchedulerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  type Entity,
} from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import { InputError, isError, NotFoundError } from '@backstage/errors';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';

// @ts-ignore
import { merge } from 'lodash';
import { LimitFunction } from 'p-limit';
import * as uuid from 'uuid';

import {
  GroupTransformer,
  KEYCLOAK_ID_ANNOTATION,
  KeycloakProviderConfig,
  UserTransformer,
} from '../lib';
import { readProviderConfigs } from '../lib/config';
import { parseUser, readKeycloakRealm } from '../lib/read';
import { authenticate } from '../lib/authenticate';
import { Attributes, Counter, Meter, metrics } from '@opentelemetry/api';
import { EventsService } from '@backstage/plugin-events-node';
import KeycloakAdminClient from '@keycloak/keycloak-admin-client';
import { CatalogApi, CatalogClient } from '@backstage/catalog-client';

/**
 * Options for {@link KeycloakOrgEntityProvider}.
 *
 * @public
 */
export interface KeycloakOrgEntityProviderOptions {
  /**
   * A unique, stable identifier for this provider.
   *
   * @example "production"
   */
  id: string;

  /**
   * The refresh schedule to use.
   * @remarks
   *
   * You can pass in the result of
   * {@link @backstage/backend-plugin-api#SchedulerService.createScheduledTaskRunner}
   * to enable automatic scheduling of tasks.
   */
  schedule?: SchedulerServiceTaskRunner;

  /**
   * Scheduler used to schedule refreshes based on
   * the schedule config.
   */
  scheduler?: SchedulerService;

  /**
   * The logger to use.
   */
  logger: LoggerService;

  /**
   * The function that transforms a user entry in LDAP to an entity.
   */
  userTransformer?: UserTransformer;

  /**
   * The function that transforms a group entry in LDAP to an entity.
   */
  groupTransformer?: GroupTransformer;
}

// Makes sure that emitted entities have a proper location
export const withLocations = (
  baseUrl: string,
  realm: string,
  entity: Entity,
): Entity => {
  const kind = entity.kind === 'Group' ? 'groups' : 'users';
  const location = `url:${baseUrl}/admin/realms/${realm}/${kind}/${entity.metadata.annotations?.[KEYCLOAK_ID_ANNOTATION]}`;
  return merge(
    {
      metadata: {
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
        },
      },
    },
    entity,
  ) as Entity;
};

const TOPIC_USER_CREATE = 'admin.USER-CREATE';
const TOPIC_USER_DELETE = 'admin.USER-DELETE';
const TOPIC_USER_UPDATE = 'admin.USER-UPDATE';
const TOPIC_USER_ADD_GROUP = 'admin.GROUP_MEMBERSHIP-CREATE';
const TOPIC_USER_REMOVE_GROUP = 'admin.GROUP_MEMBERSHIP-DELETE';

/**
 * Ingests org data (users and groups) from Keycloak.
 *
 * @public
 */
export class KeycloakOrgEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private meter: Meter;
  private counter: Counter<Attributes>;
  private scheduleFn?: () => Promise<void>;
  private readonly events?: EventsService;
  private readonly catalogApi: CatalogApi;

  /**
   * Static builder method to create multiple KeycloakOrgEntityProvider instances from a single config.
   * @param deps - The dependencies required for the provider, including the configuration and logger.
   * @param options - Options for scheduling tasks and transforming users and groups.
   * @returns An array of KeycloakOrgEntityProvider instances.
   */
  static fromConfig(
    deps: {
      config: Config;
      logger: LoggerService;
      catalogApi: CatalogApi;
      events: EventsService;
      discovery: DiscoveryService;
    },
    options: (
      | { schedule: SchedulerServiceTaskRunner }
      | { scheduler: SchedulerService }
    ) & {
      userTransformer?: UserTransformer;
      groupTransformer?: GroupTransformer;
    },
  ): KeycloakOrgEntityProvider[] {
    const { config, logger, catalogApi, events, discovery } = deps;
    return readProviderConfigs(config).map(providerConfig => {
      let taskRunner: SchedulerServiceTaskRunner | string;
      if ('scheduler' in options && providerConfig.schedule) {
        // Create a scheduled task runner using the provided scheduler and schedule configuration
        taskRunner = options.scheduler.createScheduledTaskRunner(
          providerConfig.schedule,
        );
      } else if ('schedule' in options) {
        // Use the provided schedule directly
        taskRunner = options.schedule;
      } else {
        throw new InputError(
          `No schedule provided via config for KeycloakOrgEntityProvider:${providerConfig.id}.`,
        );
      }

      const provider = new KeycloakOrgEntityProvider({
        id: providerConfig.id,
        provider: providerConfig,
        logger: logger,
        events: events,
        discovery: discovery,
        catalogApi: catalogApi,
        taskRunner: taskRunner,
        userTransformer: options.userTransformer,
        groupTransformer: options.groupTransformer,
      });

      return provider;
    });
  }

  constructor(
    private options: {
      id: string;
      provider: KeycloakProviderConfig;
      logger: LoggerService;
      taskRunner: SchedulerServiceTaskRunner;
      events: EventsService;
      catalogApi: CatalogApi;
      discovery: DiscoveryService;
      userTransformer?: UserTransformer;
      groupTransformer?: GroupTransformer;
    },
  ) {
    this.meter = metrics.getMeter('default');
    this.counter = this.meter.createCounter(
      'backend_keycloak.fetch.task.failure.count',
      {
        description:
          'Counts the number of failed Keycloak data fetch tasks. Each increment indicates a complete failure of a fetch task, meaning no data was provided to the Catalog API. However, data may still be fetched in subsequent tasks, depending on the nature of the error.',
      },
    );
    this.schedule(options.taskRunner);
    this.events = options.events;
    this.catalogApi = options.catalogApi
      ? options.catalogApi
      : new CatalogClient({ discoveryApi: options.discovery });
  }

  /**
   * Returns the name of this entity provider.
   */
  getProviderName(): string {
    return `KeycloakOrgEntityProvider:${this.options.id}`;
  }

  /**
   * Connect to Backstage catalog entity provider
   * @param connection - The connection to the catalog API ingestor, which allows the provision of new entities.
   */
  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
    console.log(`Events: ${JSON.stringify(this.events)}`);
    await this.events?.subscribe({
      id: this.getProviderName(),
      topics: [
        TOPIC_USER_CREATE,
        TOPIC_USER_DELETE,
        TOPIC_USER_UPDATE,
        TOPIC_USER_ADD_GROUP,
        TOPIC_USER_REMOVE_GROUP,
        'keycloak' // Just added this for testing purposes, will remove later
      ],
      onEvent: async params => {
        console.log('In KeycloakOrgEntityProvider, params:', params);
        const logger = this.options.logger;
        const provider = this.options.provider;

        logger.info(`Received event :${params.topic}`);

        const KeyCloakAdminClientModule = await import(
          '@keycloak/keycloak-admin-client'
        );
        const KeyCloakAdminClient = KeyCloakAdminClientModule.default;

        const kcAdminClient = new KeyCloakAdminClient({
          baseUrl: provider.baseUrl,
          realmName: provider.loginRealm,
        });
        await authenticate(kcAdminClient, provider, logger);

        // TODO: Does it even make sense to add a user Entity without a group? Should this event just be ignored and we only listen for CREATE_MEMBERSHIP instead?
        if (
          params.eventPayload.type === TOPIC_USER_CREATE ||
          params.eventPayload.type === TOPIC_USER_DELETE
        ) {
          await this.onUserEvent({
            logger,
            eventPayload: params.eventPayload,
            client: kcAdminClient,
          });
        }
        if (params.eventPayload.type === TOPIC_USER_UPDATE) {
          await this.onUserEdit({
            logger,
            eventPayload: params.eventPayload,
            client: kcAdminClient,
          });
        }
        // if (
        //   params.eventPayload.type === TOPIC_USER_ADD_GROUP ||
        //   params.eventPayload.type === TOPIC_USER_REMOVE_GROUP
        // ) {
        //   await this.onMembershipChange({
        //     logger,
        //     eventPayload: params.eventPayload,
        //     client: kcAdminClient,
        //   });
        // }
      },
    });
    await this.scheduleFn?.();
  }

  private addEntitiesOperation = (entities: Entity[]) => ({
    removed: [],
    added: entities.map(entity => ({
      locationKey: `keycloak-org-provider:${this.options.id}`,
      entity: withLocations(
        this.options.provider.baseUrl,
        this.options.provider.realm,
        entity,
      ),
    })),
  });

  private removeEntitiesOperation = (entities: Entity[]) => ({
    added: [],
    removed: entities.map(entity => ({
      locationKey: `keycloak-org-provider:${this.options.id}`,
      entity: withLocations(
        this.options.provider.baseUrl,
        this.options.provider.realm,
        entity,
      ),
    })),
  });

  private async onUserEdit(options: {
    logger?: LoggerService;
    eventPayload: any;
    client: KeycloakAdminClient;
  }): Promise<void> {
    if (!this.connection) {
      throw new NotFoundError('Not initialized');
    }
    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const client = options.client;
    const userId = options.eventPayload.resourcePath.split('/')[1];

    const { items } = await this.catalogApi.getEntities({
      filter: {
        kind: 'User',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: userId,
      },
    });

    // TODO: Get all the groups this user belongs to and update them as well because their members field might change if newUser has a different name field

    const oldUserEntity = items[0];

    const newUser = await client.users.findOne({ id: userId });
    if (!newUser) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_UPDATE event`,
      );
      return;
    }

    const newUserEntity = await parseUser(
      newUser,
      provider.realm,
      [],
      new Map(),
      this.options.userTransformer,
    );

    if (!newUserEntity || !oldUserEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }

    const { added } = this.addEntitiesOperation([newUserEntity]);
    const { removed } = this.removeEntitiesOperation([oldUserEntity]);

    await this.connection.applyMutation({
      type: 'delta',
      added: added,
      removed: removed,
    });
  }
  private async onUserEvent(options: {
    logger?: LoggerService;
    eventPayload: any;
    client: KeycloakAdminClient;
  }): Promise<void> {
    if (!this.connection) {
      throw new NotFoundError('Not initialized');
    }

    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const client = options.client;
    const userId = options.eventPayload.resourcePath.split('/')[1];
    let userEntity: Entity | undefined;

    if (options.eventPayload.type === TOPIC_USER_CREATE) {
      const userAdded = await client.users.findOne({ id: userId });

      if (!userAdded) {
        logger.debug(
          `Failed to fetch user with ID ${userId} after USER_CREATE event`,
        );
        return;
      }

      userEntity = await parseUser(
        userAdded,
        provider.realm,
        [],
        new Map(),
        this.options.userTransformer,
      );
    }
    if (options.eventPayload.type === TOPIC_USER_DELETE) {
      // Query the catalog for a user entity with the Keycloak ID annotation
      const { items } = await this.catalogApi.getEntities({
        filter: {
          kind: 'User',
          [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: userId,
        },
      });
      userEntity = items[0];

      // TODO: Get all the groups this user belongs to and update them as well because their members field will change.
    }

    if (!userEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }

    const createDeltaOperation =
      options.eventPayload.type === TOPIC_USER_CREATE
        ? this.addEntitiesOperation
        : this.removeEntitiesOperation;

    const { added, removed } = createDeltaOperation([userEntity]);

    await this.connection.applyMutation({
      type: 'delta',
      added: added,
      removed: removed,
    });

    logger.info(
      `Processed Keycloak user event: ${options.eventPayload.type} for user ID ${userId}`,
    );
  }

  // private async onMembershipChange(options: {
  //   logger?: LoggerService;
  //   eventPayload: any;
  //   client: KeycloakAdminClient;
  // }): Promise<void> {
  //   // If user is added/removed as a member of a group: members field for that group needs updating, memberOf field of the user needs updating
  //   if (!this.connection) {
  //     throw new NotFoundError('Not initialized');
  //   }

  //   const logger = options?.logger ?? this.options.logger;
  //   const provider = this.options.provider;
  //   const client = options.client;
  // }

  // private async onGroupEvent(options: {
  //   logger?: LoggerService;
  //   eventPayload: any;
  //   client: KeycloakAdminClient;
  // }): Promise<void> {
  //   // GROUP-CREATE
  //   // 1. Top-level group: fetch group by ID and add it as a new entity in the catalog (no `/children` in resourcePath)
  //   // 2. Subgroup: update the parent group and add the new subgroup as a separate entity in the catalog (`/children` in resourcePath)
  //   // GROUP-DELETE
  //   // Update the parent group, and remove the deleted group along with all its subgroups (resourcePath is `groups/<id-of-deleted-group>`)
  //   // GROUP-UPDATE
  //   // - Updating group name/metadata: update the parent, the group itself, and its subgroups
  //   // - Moving a group to another parent: update the old parent, the group itself, and the new parent (subgroups stay under the group, no changes needed for them)
  // }

  /**
   * Runs one complete ingestion loop. Call this method regularly at some
   * appropriate cadence.
   */
  async read(options: { logger?: LoggerService; taskInstanceId: string }) {
    if (!this.connection) {
      throw new NotFoundError('Not initialized');
    }

    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;

    const { markReadComplete } = trackProgress(logger);
    const KeyCloakAdminClientModule = await import(
      '@keycloak/keycloak-admin-client'
    );
    const KeyCloakAdminClient = KeyCloakAdminClientModule.default;

    const kcAdminClient = new KeyCloakAdminClient({
      baseUrl: provider.baseUrl,
      realmName: provider.loginRealm,
    });
    await authenticate(kcAdminClient, provider, logger);

    const pLimitCJSModule = await import('p-limit');
    const limitFunc = pLimitCJSModule.default;
    const concurrency = provider.maxConcurrency ?? 20;
    const limit: LimitFunction = limitFunc(concurrency);

    const dataBatchFailureCounter = this.meter.createCounter(
      'backend_keycloak.fetch.data.batch.failure.count',
      {
        description:
          'Keycloak data batch fetch failure counter. Incremented for each batch fetch failure. Each failure means that a part of the data was not fetched due to an error, and thus the corresponding data batch was skipped during the current fetch task.',
      },
    );
    const { users, groups } = await readKeycloakRealm(
      kcAdminClient,
      provider,
      logger,
      limit,
      options.taskInstanceId,
      dataBatchFailureCounter,
      {
        userQuerySize: provider.userQuerySize,
        groupQuerySize: provider.groupQuerySize,
        userTransformer: this.options.userTransformer,
        groupTransformer: this.options.groupTransformer,
      },
    );

    const { markCommitComplete } = markReadComplete({ users, groups });

    await this.connection.applyMutation({
      type: 'full',
      entities: [...users, ...groups].map(entity => ({
        locationKey: `keycloak-org-provider:${this.options.id}`,
        entity: withLocations(provider.baseUrl, provider.realm, entity),
      })),
    });

    markCommitComplete();
  }

  /**
   * Periodically schedules a task to read Keycloak user and group information, parse it, and provision it to the Backstage catalog.
   * @param taskRunner - The task runner to use for scheduling tasks.
   */
  schedule(taskRunner: SchedulerServiceTaskRunner) {
    this.scheduleFn = async () => {
      const id = `${this.getProviderName()}:refresh`;
      await taskRunner.run({
        id,
        fn: async () => {
          const taskInstanceId = uuid.v4();
          const logger = this.options.logger.child({
            class: KeycloakOrgEntityProvider.prototype.constructor.name,
            taskId: id,
            taskInstanceId: taskInstanceId,
          });

          try {
            await this.read({ logger, taskInstanceId });
          } catch (error) {
            this.counter.add(1, { taskInstanceId: taskInstanceId });
            if (isError(error)) {
              // Ensure that we don't log any sensitive internal data:
              logger.error('Error while syncing Keycloak users and groups', {
                // Default Error properties:
                name: error.name,
                cause: error.cause,
                message: error.message,
                stack: error.stack,
                // Additional status code if available:
                status: (error.response as { status?: string })?.status,
              });
            }
          }
        },
      });
    };
  }
}

// Helps wrap the timing and logging behaviors
function trackProgress(logger: LoggerService) {
  let timestamp = Date.now();
  let summary: string;

  logger.info('Reading Keycloak users and groups');

  function markReadComplete(read: { users: unknown[]; groups: unknown[] }) {
    summary = `${read.users.length} Keycloak users and ${read.groups.length} Keycloak groups`;
    const readDuration = ((Date.now() - timestamp) / 1000).toFixed(1);
    timestamp = Date.now();
    logger.info(`Read ${summary} in ${readDuration} seconds. Committing...`);
    return { markCommitComplete };
  }

  function markCommitComplete() {
    const commitDuration = ((Date.now() - timestamp) / 1000).toFixed(1);
    logger.info(`Committed ${summary} in ${commitDuration} seconds.`);
  }

  return { markReadComplete };
}
