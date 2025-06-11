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
  GroupEntity,
  UserEntity,
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
import {
  getAllGroups,
  getServerVersion,
  parseGroup,
  parseUser,
  processGroupsRecursively,
  readKeycloakRealm,
  traverseGroups,
} from '../lib/read';
import { authenticate, ensureTokenValid } from '../lib/authenticate';
import { Attributes, Counter, Meter, metrics } from '@opentelemetry/api';
import { EventsService } from '@backstage/plugin-events-node';
import KeycloakAdminClient from '@keycloak/keycloak-admin-client';
import { CatalogApi, CatalogClient } from '@backstage/catalog-client';
import {
  GroupRepresentationWithParent,
  GroupRepresentationWithParentAndEntity,
} from '../lib/types';
import { getAllGroupMembers } from '../lib/read';
import GroupRepresentation from '@keycloak/keycloak-admin-client/lib/defs/groupRepresentation';
import {
  KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT,
  KEYCLOAK_REALM_ANNOTATION,
} from '../lib/constants';
import { noopUserTransformer } from '../lib/transformers';
import { Groups } from '@keycloak/keycloak-admin-client/lib/resources/groups';

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
const TOPIC_GROUP_CREATE = 'admin.GROUP-CREATE';
const TOPIC_GROUP_DELETE = 'admin.GROUP-DELETE';
const TOPIC_GROUP_UPDATE = 'admin.GROUP-UPDATE';

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
    await this.events?.subscribe({
      id: this.getProviderName(),
      topics: ['keycloak'],
      onEvent: async params => {
        const logger = this.options.logger;
        const provider = this.options.provider;

        logger.info(`Received event :${params.topic}`);

        const eventPayload = params.eventPayload as {
          type: string;
          [key: string]: any;
        };

        const KeyCloakAdminClientModule = await import(
          '@keycloak/keycloak-admin-client'
        );
        const KeyCloakAdminClient = KeyCloakAdminClientModule.default;

        const kcAdminClient = new KeyCloakAdminClient({
          baseUrl: provider.baseUrl,
          realmName: provider.loginRealm,
        });
        await authenticate(kcAdminClient, provider, logger);

        if (
          eventPayload.type === TOPIC_USER_CREATE ||
          eventPayload.type === TOPIC_USER_DELETE ||
          eventPayload.type === TOPIC_USER_UPDATE
        ) {
          await this.onUserEvent({
            logger,
            eventPayload: eventPayload,
            client: kcAdminClient,
          });
        }

        if (
          eventPayload.type === TOPIC_USER_ADD_GROUP ||
          eventPayload.type === TOPIC_USER_REMOVE_GROUP
        ) {
          await this.onMembershipChange({
            logger,
            eventPayload: eventPayload,
            client: kcAdminClient,
          });
        }

        if (
          eventPayload.type === TOPIC_GROUP_CREATE ||
          eventPayload.type === TOPIC_GROUP_UPDATE ||
          eventPayload.type === TOPIC_GROUP_DELETE
        ) {
          await this.onGroupEvent({
            logger,
            eventPayload: eventPayload,
            client: kcAdminClient,
          });
        }
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

    if (options.eventPayload.type === TOPIC_USER_CREATE) {
      await this.handleUserCreate(userId, client, provider, logger);
    }
    if (options.eventPayload.type === TOPIC_USER_DELETE) {
      await this.handleUserDelete(userId, client, provider, logger);
    }

    if (options.eventPayload.type === TOPIC_USER_UPDATE) {
      await this.onUserEdit(userId, client, provider, logger);
    }

    logger.info(
      `Processed Keycloak User Event: ${options.eventPayload.type} for user ID ${userId}`,
    );
  }

  private async handleUserCreate(
    userId: string,
    client: KeycloakAdminClient,
    provider: KeycloakProviderConfig,
    logger: LoggerService,
  ): Promise<void> {
    const userAdded = await client.users.findOne({ id: userId });

    if (!userAdded) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_CREATE event`,
      );
      return;
    }

    const userEntity = await parseUser(
      userAdded,
      provider.realm,
      [],
      new Map(),
      this.options.userTransformer,
    );

    if (!userEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }

    const { added } = this.addEntitiesOperation([userEntity]);

    await this.connection!.applyMutation({
      type: 'delta',
      added: added,
      removed: [],
    });
  }

  private async handleUserDelete(
    userId: string,
    client: KeycloakAdminClient,
    provider: KeycloakProviderConfig,
    logger: LoggerService,
  ): Promise<void> {
    const {
      items: [userEntity],
    } = await this.catalogApi.getEntities({
      filter: {
        kind: 'User',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: userId,
      },
    });

    // Update Groups that the user belonged to
    const oldGroupEntityRefs =
      userEntity?.relations
        ?.filter(r => r.type === 'memberOf')
        .map(r => r.targetRef) ?? [];
    const oldGroupEntities = (
      await Promise.all(
        oldGroupEntityRefs.map(ref => this.catalogApi.getEntityByRef(ref)),
      )
    ).filter((entity): entity is Entity => !entity);

    const allGroups: GroupRepresentation[] = (
      await Promise.all(
        oldGroupEntities.map(async group => {
          if (group.metadata.annotations) {
            return await client.groups.findOne({
              id: group.metadata.annotations[KEYCLOAK_ID_ANNOTATION],
              realm: provider.realm,
            });
          }
          return undefined;
        }),
      )
    ).filter((g): g is GroupRepresentation => !g);

    const filteredParsedGroups = await this.createGroupEntities(
      allGroups,
      provider,
      client,
      logger,
    );

    if (!userEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }

    const { removed } = this.removeEntitiesOperation([
      userEntity,
      ...oldGroupEntities,
    ]);

    const { added } = this.addEntitiesOperation([
      ...filteredParsedGroups.map(g => g.entity),
    ]);

    await this.connection!.applyMutation({
      type: 'delta',
      added: added,
      removed: removed,
    });
  }

  private async onUserEdit(
    userId: string,
    client: KeycloakAdminClient,
    provider: KeycloakProviderConfig,
    logger: LoggerService,
  ): Promise<void> {
    const {
      items: [oldUserEntity],
    } = await this.catalogApi.getEntities({
      filter: {
        kind: 'User',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: userId,
      },
    });

    const oldGroupEntityRefs =
      oldUserEntity?.relations
        ?.filter(r => r.type === 'memberOf')
        .map(r => r.targetRef) ?? [];
    const oldGroupEntities = (
      await Promise.all(
        oldGroupEntityRefs.map(ref => this.catalogApi.getEntityByRef(ref)),
      )
    ).filter((entity): entity is Entity => !entity);

    const allGroups: GroupRepresentation[] = (
      await Promise.all(
        oldGroupEntities.map(async group => {
          if (group.metadata.annotations) {
            return await client.groups.findOne({
              id: group.metadata.annotations[KEYCLOAK_ID_ANNOTATION],
              realm: provider.realm,
            });
          }
          return undefined;
        }),
      )
    ).filter((g): g is GroupRepresentation => !g);

    const filteredParsedGroups = await this.createGroupEntities(
      allGroups,
      provider,
      client,
      logger,
    );

    const newUser = await client.users.findOne({ id: userId });
    if (!newUser) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_UPDATE event`,
      );
      return;
    }

    const userToGroupMapping = new Map<string, string[]>();
    if (newUser.username) {
      userToGroupMapping.set(
        newUser.username,
        filteredParsedGroups.map(g => g.entity.metadata.name),
      );
    }

    const newUserEntity = await parseUser(
      newUser,
      provider.realm,
      filteredParsedGroups,
      userToGroupMapping,
      this.options.userTransformer,
    );

    if (!newUserEntity || !oldUserEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }

    const { added } = this.addEntitiesOperation([newUserEntity]);
    const { removed } = this.removeEntitiesOperation([oldUserEntity]);

    await this.connection!.applyMutation({
      type: 'delta',
      added: added,
      removed: removed,
    });
  }

  private async onMembershipChange(options: {
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
    const groupId = options.eventPayload.resourcePath.split('/')[3];

    const {
      items: [oldUserEntity],
    } = await this.catalogApi.getEntities({
      filter: {
        kind: 'User',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: userId,
      },
    });

    const {
      items: [oldGroupEntity],
    } = await this.catalogApi.getEntities({
      filter: {
        kind: 'Group',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: groupId,
      },
    });

    const newUser = await client.users.findOne({ id: userId });
    if (!newUser) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_UPDATE event`,
      );
      return;
    }

    const newGroup = (await client.groups.findOne({
      id: groupId,
    })) as GroupRepresentationWithParent;

    newGroup.members = await getAllGroupMembers(
      async () => {
        await ensureTokenValid(client, provider, logger);
        return client.groups;
      },
      groupId,
      provider,
      {
        userQuerySize: provider.userQuerySize,
      },
    );

    let newGroupEntity: GroupRepresentationWithParentAndEntity | null = null;

    const parsedGroup = (await parseGroup(
      newGroup,
      provider.realm,
      this.options.groupTransformer,
    )) as GroupRepresentationWithParent;

    if (parsedGroup) {
      newGroupEntity = {
        ...parsedGroup,
        entity: parsedGroup,
      } as GroupRepresentationWithParentAndEntity;
    }

    if (!newGroupEntity) {
      logger.debug(`Failed to parse group entity for group ID ${groupId}`);
      return;
    }

    const memberToGroupMap = new Map<string, string[]>();

    const currentGroupMemberships =
      (oldUserEntity.spec?.memberOf as string[]) ?? [];

    if (options.eventPayload.type === TOPIC_USER_ADD_GROUP) {
      // If the user is being added to a group, we need to add the group to the user's memberOf field
      currentGroupMemberships.push(newGroupEntity.entity.metadata.name);
    } else {
      // If the user is being removed from a group, we need to remove the group from the user's memberOf field
      const index = currentGroupMemberships.indexOf(
        newGroupEntity.entity.metadata.name,
      );
      if (index > -1) {
        currentGroupMemberships.splice(index, 1);
      }
    }

    memberToGroupMap.set(oldUserEntity.metadata.name, currentGroupMemberships);

    const newUserEntity = await parseUser(
      newUser,
      provider.realm,
      [newGroupEntity],
      memberToGroupMap,
      this.options.userTransformer,
    );

    if (!newUserEntity || !oldUserEntity) {
      logger.debug(
        `Failed to find user entity for user ID ${userId} after membership change event`,
      );
      return;
    }

    if (!oldGroupEntity || !newGroupEntity) {
      logger.debug(
        `Failed to find group entity for group ID ${groupId} after membership change event`,
      );
      return;
    }

    const { added } = this.addEntitiesOperation([
      newUserEntity,
      newGroupEntity.entity,
    ]);
    const { removed } = this.removeEntitiesOperation([
      oldUserEntity,
      oldGroupEntity,
    ]);

    await this.connection.applyMutation({
      type: 'delta',
      added,
      removed,
    });

    logger.info(
      `Processed Keycloak User Membership Change Event: ${options.eventPayload.type} for user ID ${userId} and group ID ${groupId}`,
    );
  }

  private async onGroupEvent(options: {
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
    const resourcePath = options.eventPayload.resourcePath.split('/');

    if (options.eventPayload.type === 'admin.GROUP-CREATE') {
      await this.handleGroupCreate(
        resourcePath,
        options,
        logger,
        provider,
        client,
      );
    }
    if (options.eventPayload.type === 'admin.GROUP-DELETE') {
      await this.handleGroupDelete(resourcePath, logger, provider, client);
    }
    // TODO: GROUP-UPDATE
    // - Updating group name/metadata: update the parent, the group itself, and its subgroups
    // - Moving a group to another parent: update the old parent, the group itself, and the new parent (subgroups stay under the group, no changes needed for them)
  }

  private async handleGroupCreate(
    resourcePath: string[],
    options: {
      logger?: LoggerService;
      eventPayload: any;
      client: KeycloakAdminClient;
    },
    logger: LoggerService,
    provider: KeycloakProviderConfig,
    client: KeycloakAdminClient,
  ) {
    // 1. Top-level group: fetch group by ID and add it as a new entity in the catalog
    if (resourcePath.length === 2) {
      const groupId = resourcePath[1];
      const group = await client.groups.findOne({ id: groupId });
      if (!group) {
        logger.debug(
          `Failed to fetch group with ID ${groupId} after GROUP_CREATE event`,
        );
        return;
      }
      const groupEntity = await parseGroup(
        group,
        provider.realm,
        this.options.groupTransformer,
      );
      if (!groupEntity) {
        logger.debug(`Failed to parse group entity for group ID ${groupId}`);
        return;
      }

      const { added } = this.addEntitiesOperation([groupEntity]);

      await this.connection!.applyMutation({
        type: 'delta',
        added: added,
        removed: [],
      });
      logger.info(
        `Processed Keycloak Event ${options.eventPayload.type} for top-level group ID ${groupId}`,
      );
    }
    // 2. Subgroup: update the parent group and add the new subgroup as a separate entity in the catalog
    else if (resourcePath.length === 3) {
      const parentGroupId = resourcePath[1];
      const subgroupId = JSON.parse(options.eventPayload.representation).id;
      const newParentGroup = (await client.groups.findOne({
        id: parentGroupId,
      })) as GroupRepresentationWithParent;
      if (!newParentGroup) {
        logger.debug(
          `Failed to fetch parent group with ID ${parentGroupId} after GROUP_CREATE event`,
        );
        return;
      }
      const subgroup = (await client.groups.findOne({
        id: subgroupId,
      })) as GroupRepresentationWithParent;
      if (!subgroup) {
        logger.debug(
          `Failed to fetch subgroup with ID ${subgroupId} after GROUP_CREATE event`,
        );
        return;
      }

      // Find the old parent group entity
      const {
        items: [oldParentGroupEntity],
      } = (await this.catalogApi.getEntities({
        filter: {
          kind: 'Group',
          [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: parentGroupId,
        },
      })) as { items: [GroupEntity] };

      if (!oldParentGroupEntity) {
        logger.debug(
          `Failed to find old parent group entity for group ID ${parentGroupId} after GROUP_CREATE event`,
        );
        return;
      }

      const filteredParsedGroups = await this.createGroupEntities(
        [subgroup, newParentGroup],
        provider,
        client,
        logger,
      );

      if (filteredParsedGroups.length === 0) {
        logger.debug(
          `Failed to parse group entities for parent group ID ${parentGroupId} and subgroup ID ${subgroupId}`,
        );
        return;
      }

      const { added } = this.addEntitiesOperation(
        filteredParsedGroups.map(g => g.entity),
      );
      const { removed } = this.removeEntitiesOperation([oldParentGroupEntity]);
      await this.connection!.applyMutation({
        type: 'delta',
        added: added,
        removed: removed,
      });
      logger.info(
        `Processed Keycloak Event: ${options.eventPayload.type} for subgroup ID ${subgroupId} under parent group ID ${parentGroupId}`,
      );
    }
  }

  private async handleGroupDelete(
    resourcePath: string[],
    logger: LoggerService,
    provider: KeycloakProviderConfig,
    client: KeycloakAdminClient,
  ) {
    const groupId = resourcePath[1];
    const {
      items: [deletedGroup],
    } = (await this.catalogApi.getEntities({
      filter: {
        kind: 'Group',
        [`metadata.annotations.${KEYCLOAK_ID_ANNOTATION}`]: groupId,
      },
    })) as { items: [GroupEntity] };

    const parentEntityRef = this.getParentEntityRef(deletedGroup);
    const subgroupRefs = this.getSubgroupRefs(deletedGroup);

    const oldParentEntity = parentEntityRef
      ? await this.catalogApi.getEntityByRef(parentEntityRef)
      : undefined;

    const validSubgroupEntities = await this.getEntitiesByRefs(subgroupRefs);

    let newParent;
    if (
      oldParentEntity &&
      oldParentEntity.metadata &&
      oldParentEntity.metadata.annotations &&
      oldParentEntity.metadata.annotations[KEYCLOAK_ID_ANNOTATION]
    ) {
      newParent = (await client.groups.findOne({
        id: oldParentEntity.metadata.annotations[KEYCLOAK_ID_ANNOTATION],
      })) as GroupRepresentationWithParent;
    }

    const [newParentEntity] = await this.createGroupEntities(
      [newParent].filter((g): g is GroupRepresentationWithParent => !!g),
      provider,
      client,
      logger,
    );

    const userMembershipsToUpdate = this.collectUserMemberships(
      deletedGroup,
      validSubgroupEntities,
    );

    const { oldUserEntities, newUserEntities } =
      await this.updateUserEntitiesAfterGroupDelete(
        userMembershipsToUpdate,
        provider,
        client,
        logger,
      );

    const { added } = this.addEntitiesOperation([
      ...(newParentEntity ? [newParentEntity.entity] : []),
      ...newUserEntities,
    ]);

    const { removed } = this.removeEntitiesOperation([
      deletedGroup,
      ...(oldParentEntity ? [oldParentEntity] : []),
      ...validSubgroupEntities,
      ...oldUserEntities,
    ]);

    await this.connection!.applyMutation({
      type: 'delta',
      added,
      removed,
    });

    logger.info(
      `Processed Keycloak group deletion event for group ID ${groupId} and its subgroups`,
    );
  }

  private getParentEntityRef(group: GroupEntity): string | undefined {
    return group.relations?.find(relation => relation.type === 'childOf')
      ?.targetRef;
  }

  private getSubgroupRefs(group: GroupEntity): string[] {
    return (
      group.relations
        ?.filter(relation => relation.type === 'parentOf')
        .map(relation => relation.targetRef) ?? []
    );
  }

  private async getEntitiesByRefs(refs: string[]): Promise<Entity[]> {
    const entities = await Promise.all(
      refs.map(ref => this.catalogApi.getEntityByRef(ref)),
    );
    return entities.filter((entity): entity is Entity => !!entity);
  }

  private collectUserMemberships(
    deletedGroup: GroupEntity,
    validSubgroupEntities: Entity[],
  ): Map<string, string[]> {
    const userMembershipsToUpdate: Map<string, string[]> = new Map(
      deletedGroup.relations
        ?.filter(relation => relation.type === 'hasMember')
        .map(relation => [
          relation.targetRef,
          [
            `${deletedGroup.kind}:${deletedGroup.metadata.namespace}/${deletedGroup.metadata.name}`.toLowerCase(),
          ],
        ]) ?? [],
    );

    validSubgroupEntities.forEach(subgroup => {
      const subgroupMemberships = subgroup.relations?.filter(
        relation => relation.type === 'hasMember',
      );
      if (subgroupMemberships) {
        subgroupMemberships.forEach(relation => {
          const currentMembers =
            userMembershipsToUpdate.get(relation.targetRef) ?? [];
          userMembershipsToUpdate.set(relation.targetRef, [
            ...currentMembers,
            `${subgroup.kind}:${subgroup.metadata.namespace}/${subgroup.metadata.name}`.toLowerCase(),
          ]);
        });
      }
    });

    return userMembershipsToUpdate;
  }

  private async updateUserEntitiesAfterGroupDelete(
    userMembershipsToUpdate: Map<string, string[]>,
    provider: KeycloakProviderConfig,
    client: KeycloakAdminClient,
    logger: LoggerService,
  ): Promise<{ oldUserEntities: Entity[]; newUserEntities: Entity[] }> {
    const oldUserEntities: Entity[] = [];
    const newUserEntities: Entity[] = [];

    for (const [userEntityRef] of userMembershipsToUpdate.entries()) {
      const userEntityInCatalog = await this.catalogApi.getEntityByRef(
        userEntityRef,
      );
      if (userEntityInCatalog?.metadata.annotations?.[KEYCLOAK_ID_ANNOTATION]) {
        oldUserEntities.push(userEntityInCatalog);
        const userFromKeycloak = await client.users.findOne({
          id: userEntityInCatalog.metadata.annotations[KEYCLOAK_ID_ANNOTATION],
        });
        if (userFromKeycloak) {
          const allGroups = await getAllGroups(
            () => Promise.resolve(client.users),
            userEntityInCatalog.metadata.annotations[KEYCLOAK_ID_ANNOTATION],
            provider,
            {
              groupQuerySize: provider.groupQuerySize,
            },
          );

          const filteredParsedGroups = await this.createGroupEntities(
            allGroups,
            provider,
            client,
            logger,
          );

          const transformer =
            this.options.userTransformer ?? noopUserTransformer;
          const entity: UserEntity = {
            apiVersion: 'backstage.io/v1beta1',
            kind: 'User',
            metadata: {
              name: userFromKeycloak.username!,
              annotations: {
                [KEYCLOAK_ID_ANNOTATION]: userFromKeycloak.id!,
                [KEYCLOAK_REALM_ANNOTATION]: provider.realm,
              },
            },
            spec: {
              profile: {
                email: userFromKeycloak.email,
                ...(userFromKeycloak.firstName || userFromKeycloak.lastName
                  ? {
                      displayName: [
                        userFromKeycloak.firstName,
                        userFromKeycloak.lastName,
                      ]
                        .filter(Boolean)
                        .join(' '),
                    }
                  : {}),
              },
              memberOf: allGroups.flatMap(g => (g?.name ? [g.name] : [])),
            },
          };

          transformer(
            entity,
            userFromKeycloak,
            provider.realm,
            filteredParsedGroups,
          );

          newUserEntities.push(entity);
        }
      }
    }
    return { oldUserEntities, newUserEntities };
  }

  private async createGroupEntities(
    allGroups: GroupRepresentationWithParent[],
    provider: KeycloakProviderConfig,
    client: KeycloakAdminClient,
    logger: LoggerService,
  ): Promise<GroupRepresentationWithParentAndEntity[]> {
    let rawKGroups: GroupRepresentationWithParent[] = [];

    let serverVersion: number;

    try {
      serverVersion = await getServerVersion(client);
    } catch (error) {
      throw new Error(
        `Failed to retrieve Keycloak server information: ${error}`,
      );
    }

    const isVersion23orHigher = serverVersion >= 23;

    if (isVersion23orHigher) {
      rawKGroups = await processGroupsRecursively(
        client,
        provider,
        logger,
        allGroups,
      );
    } else {
      rawKGroups = allGroups.reduce(
        (acc, g) => acc.concat(...traverseGroups(g)),
        [] as GroupRepresentationWithParent[],
      );
    }

    const kGroups = await Promise.all(
      rawKGroups.map(async g => {
        g.members = await getAllGroupMembers(
          async () => {
            await ensureTokenValid(client, provider, logger);
            return client.groups as Groups;
          },
          g.id!,
          provider,
          {
            userQuerySize: provider.userQuerySize,
          },
        );

        if (isVersion23orHigher) {
          if (g.subGroupCount! > 0) {
            await ensureTokenValid(client, provider, logger);
            g.subGroups = await client.groups.listSubGroups({
              parentId: g.id!,
              first: 0,
              max: g.subGroupCount,
              briefRepresentation:
                this.options.provider.briefRepresentation ??
                KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT,
              realm: provider.realm,
            });
          }
          if (g.parentId) {
            await ensureTokenValid(client, provider, logger);
            const groupParent = await client.groups.findOne({
              id: g.parentId,
              realm: provider.realm,
            });
            g.parent = groupParent?.name;
          }
        }

        return g;
      }),
    );

    const parsedGroups = await Promise.all(
      kGroups.map(async g => {
        if (!g) return null;
        const entity = await parseGroup(
          g,
          provider.realm,
          this.options.groupTransformer,
        );
        if (entity) {
          return {
            ...g,
            entity,
          } as GroupRepresentationWithParentAndEntity;
        }
        return null;
      }),
    );
    return parsedGroups.filter(
      (group): group is GroupRepresentationWithParentAndEntity =>
        group !== null,
    );
  }

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
