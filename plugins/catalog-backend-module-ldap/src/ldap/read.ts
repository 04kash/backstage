/*
 * Copyright 2020 The Backstage Authors
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

import {
  GroupEntity,
  stringifyEntityRef,
  UserEntity,
} from '@backstage/catalog-model';
import { Entry } from 'ldapts';
import lodashSet from 'lodash/set';
import cloneDeep from 'lodash/cloneDeep';
import { buildOrgHierarchy } from './org';
import { LdapClient } from './client';
import { GroupConfig, UserConfig, VendorConfig } from './config';
import {
  LDAP_DN_ANNOTATION,
  LDAP_RDN_ANNOTATION,
  LDAP_UUID_ANNOTATION,
} from './constants';
import { JsonValue } from '@backstage/types';
import { LdapVendor } from './vendors';
import { GroupTransformer, UserTransformer } from './types';
import { mapStringAttr } from './util';
import { LoggerService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';

function applyConfigSet(
  entity: object,
  set: { [path: string]: JsonValue } | undefined,
) {
  if (!set) {
    return;
  }
  const snapshot = cloneDeep(set);
  for (const [path, value] of Object.entries(snapshot)) {
    lodashSet(entity, path, value);
  }
}

function searchRequestsAttribute(
  attributes: string[] | string | undefined,
  attributeName: string,
): boolean {
  if (!Array.isArray(attributes)) {
    // Missing / non-array attributes means vendor defaults or all attrs — treat
    // as requesting the mapped attribute.
    return true;
  }
  return (
    attributes.includes('*') ||
    attributes.includes('+') ||
    attributes.includes(attributeName)
  );
}

/**
 * True when every user search config can read membership from user
 * `memberOf` (or equivalent). If any config disables user `memberOf` or does
 * not request the mapped attribute, group-side `member` may still be needed.
 */
function allUsersCanProvideMemberOf(userConfig: UserConfig[]): boolean {
  if (userConfig.length === 0) {
    return false;
  }
  return userConfig.every(cfg => {
    if (cfg.map.memberOf === undefined || cfg.map.memberOf === null) {
      return false;
    }
    return searchRequestsAttribute(cfg.options?.attributes, cfg.map.memberOf);
  });
}

/**
 * True when group search config is set up to read membership from group
 * `member` (or equivalent).
 */
function groupsRequestMembers(groupConfig: GroupConfig[]): boolean {
  return groupConfig.some(cfg => {
    if (cfg.map.members === undefined || cfg.map.members === null) {
      return false;
    }
    return searchRequestsAttribute(cfg.options?.attributes, cfg.map.members);
  });
}

/**
 * The default implementation of the transformation from an LDAP entry to a
 * User entity.
 *
 * @public
 */
export async function defaultUserTransformer(
  vendor: LdapVendor,
  config: UserConfig,
  entry: Entry,
): Promise<UserEntity | undefined> {
  const { set, map } = config;

  const entity: UserEntity = {
    apiVersion: 'backstage.io/v1beta1',
    kind: 'User',
    metadata: {
      name: '',
      annotations: {},
    },
    spec: {
      profile: {},
      memberOf: [],
    },
  };

  if (set) {
    applyConfigSet(entity, set);
  }

  mapStringAttr(entry, vendor, map.name, v => {
    entity.metadata.name = v;
  });

  if (!entity.metadata.name) {
    throw new InputError(
      `User syncing failed: missing '${map.name}' attribute, consider applying a user filter to skip processing users with incomplete data.`,
    );
  }

  mapStringAttr(entry, vendor, map.description, v => {
    entity.metadata.description = v;
  });
  mapStringAttr(entry, vendor, map.rdn, v => {
    entity.metadata.annotations![LDAP_RDN_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, vendor.uuidAttributeName, v => {
    entity.metadata.annotations![LDAP_UUID_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, vendor.dnAttributeName, v => {
    entity.metadata.annotations![LDAP_DN_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, map.displayName, v => {
    entity.spec.profile!.displayName = v;
  });
  mapStringAttr(entry, vendor, map.email, v => {
    entity.spec.profile!.email = v;
  });
  mapStringAttr(entry, vendor, map.picture, v => {
    entity.spec.profile!.picture = v;
  });

  return entity;
}

/**
 * Reads users out of an LDAP provider.
 *
 * @param client - The LDAP client
 * @param config - The user data configuration
 * @param opts - Additional options
 */
export async function readLdapUsers(
  client: LdapClient,
  userConfig: UserConfig[],
  vendorConfig: VendorConfig | undefined,
  opts?: { transformer?: UserTransformer },
): Promise<{
  users: UserEntity[]; // With all relations empty
  userMemberOf: Map<string, Set<string>>; // DN -> DN or UUID of groups
}> {
  if (userConfig.length === 0) {
    return { users: [], userMemberOf: new Map() };
  }
  const entities: UserEntity[] = [];
  const userMemberOf: Map<string, Set<string>> = new Map();
  const vendorDefaults = await client.getVendor();
  const vendor: LdapVendor = {
    dnAttributeName:
      vendorConfig?.dnAttributeName ?? vendorDefaults.dnAttributeName,
    uuidAttributeName:
      vendorConfig?.uuidAttributeName ?? vendorDefaults.uuidAttributeName,
    decodeStringAttribute: vendorDefaults.decodeStringAttribute,
  };
  const transformer = opts?.transformer ?? defaultUserTransformer;

  for (const cfg of userConfig) {
    const { dn, options, map } = cfg;
    const searchResult = await client.search(dn, options);
    for (const entry of searchResult.searchEntries) {
      const entity = await transformer(vendor, cfg, entry);

      if (!entity) {
        continue;
      }

      mapReferencesAttr(entry, vendor, map.memberOf, (myDn, vs) => {
        ensureItems(userMemberOf, myDn, vs);
      });

      entities.push(entity);
    }
  }

  return { users: entities, userMemberOf };
}

/**
 * The default implementation of the transformation from an LDAP entry to a
 * Group entity.
 *
 * @public
 */
export async function defaultGroupTransformer(
  vendor: LdapVendor,
  config: GroupConfig,
  entry: Entry,
): Promise<GroupEntity | undefined> {
  const { set, map } = config;
  const entity: GroupEntity = {
    apiVersion: 'backstage.io/v1beta1',
    kind: 'Group',
    metadata: {
      name: '',
      annotations: {},
    },
    spec: {
      type: 'unknown',
      profile: {},
      children: [],
    },
  };

  if (set) {
    applyConfigSet(entity, set);
  }

  mapStringAttr(entry, vendor, map.name, v => {
    entity.metadata.name = v;
  });

  if (!entity.metadata.name) {
    throw new InputError(
      `Group syncing failed: missing '${map.name}' attribute, consider applying a group filter to skip processing groups with incomplete data.`,
    );
  }

  mapStringAttr(entry, vendor, map.description, v => {
    entity.metadata.description = v;
  });
  mapStringAttr(entry, vendor, map.rdn, v => {
    entity.metadata.annotations![LDAP_RDN_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, vendor.uuidAttributeName, v => {
    entity.metadata.annotations![LDAP_UUID_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, vendor.dnAttributeName, v => {
    entity.metadata.annotations![LDAP_DN_ANNOTATION] = v;
  });
  mapStringAttr(entry, vendor, map.type, v => {
    entity.spec.type = v;
  });
  mapStringAttr(entry, vendor, map.displayName, v => {
    entity.spec.profile!.displayName = v;
  });
  mapStringAttr(entry, vendor, map.email, v => {
    entity.spec.profile!.email = v;
  });
  mapStringAttr(entry, vendor, map.picture, v => {
    entity.spec.profile!.picture = v;
  });

  return entity;
}

/**
 * Reads groups out of an LDAP provider.
 *
 * @param client - The LDAP client
 * @param config - The group data configuration
 * @param opts - Additional options
 */
export async function readLdapGroups(
  client: LdapClient,
  groupConfig: GroupConfig[],
  vendorConfig: VendorConfig | undefined,
  opts?: {
    transformer?: GroupTransformer;
    skipGroupMembers?: boolean;
  },
): Promise<{
  groups: GroupEntity[]; // With all relations empty
  groupMemberOf: Map<string, Set<string>>; // DN -> DN or UUID of groups
  groupMember: Map<string, Set<string>>; // DN -> DN or UUID of groups & users
}> {
  if (groupConfig.length === 0) {
    return { groups: [], groupMemberOf: new Map(), groupMember: new Map() };
  }
  const groups: GroupEntity[] = [];
  const groupMemberOf: Map<string, Set<string>> = new Map();
  const groupMember: Map<string, Set<string>> = new Map();

  const vendorDefaults = await client.getVendor();
  const vendor: LdapVendor = {
    dnAttributeName:
      vendorConfig?.dnAttributeName ?? vendorDefaults.dnAttributeName,
    uuidAttributeName:
      vendorConfig?.uuidAttributeName ?? vendorDefaults.uuidAttributeName,
    decodeStringAttribute: vendorDefaults.decodeStringAttribute,
  };

  const transformer = opts?.transformer ?? defaultGroupTransformer;

  for (const cfg of groupConfig) {
    const { dn, map, options } = cfg;
    const searchResult = await client.search(dn, options);
    for (const entry of searchResult.searchEntries) {
      const entity = await transformer(vendor, cfg, entry);

      if (!entity) {
        continue;
      }

      mapReferencesAttr(entry, vendor, map.memberOf, (myDn, vs) => {
        ensureItems(groupMemberOf, myDn, vs);
      });

      if (!opts?.skipGroupMembers) {
        mapReferencesAttr(entry, vendor, map.members, (myDn, vs) => {
          ensureItems(groupMember, myDn, vs);
        });
      }

      groups.push(entity);
    }
  }

  return {
    groups,
    groupMemberOf,
    groupMember,
  };
}

/**
 * Reads users and groups out of an LDAP provider.
 *
 * @param client - The LDAP client
 * @param userConfig - The user data configuration
 * @param groupConfig - The group data configuration
 * @param options - Additional options
 *
 * @public
 */
export async function readLdapOrg(
  client: LdapClient,
  userConfig: UserConfig[],
  groupConfig: GroupConfig[],
  vendorConfig: VendorConfig | undefined,
  options: {
    groupClient?: LdapClient;
    groupTransformer?: GroupTransformer;
    userTransformer?: UserTransformer;
    logger: LoggerService;
  },
): Promise<{
  users: UserEntity[];
  groups: GroupEntity[];
}> {
  // Invokes the above "raw" read functions and stitches together the results
  // with all relations etc filled in.

  const groupClient = options.groupClient ?? client;
  // Prefer user memberOf only when every user config can source membership
  // that way and group member lists are not requested. If any user config
  // relies on group-side membership, keep hydrating group members.
  const skipGroupMembers =
    allUsersCanProvideMemberOf(userConfig) &&
    !groupsRequestMembers(groupConfig);

  const [usersResult, groupsResult] = await Promise.all([
    readLdapUsers(client, userConfig, vendorConfig, {
      transformer: options?.userTransformer,
    }),
    readLdapGroups(groupClient, groupConfig, vendorConfig, {
      transformer: options?.groupTransformer,
      skipGroupMembers,
    }),
  ]);

  const { users, userMemberOf } = usersResult;
  const { groups, groupMemberOf, groupMember } = groupsResult;

  resolveRelations(groups, users, userMemberOf, groupMemberOf, groupMember);
  users.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  groups.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  return { users, groups };
}

//
// Helpers
//

// Maps a multi-valued attribute of references to other objects, to a consumer
function mapReferencesAttr(
  entry: Entry,
  vendor: LdapVendor,
  attributeName: string | undefined | null,
  setter: (sourceDn: string, targets: string[]) => void,
) {
  if (attributeName) {
    const values = vendor.decodeStringAttribute(entry, attributeName);
    const dn = vendor.decodeStringAttribute(entry, vendor.dnAttributeName);
    if (values && dn && dn.length === 1) {
      setter(dn[0], values);
    }
  }
}

// Inserts a number of values in a key-values mapping
function ensureItems(
  target: Map<string, Set<string>>,
  key: string,
  values: string[],
) {
  if (key) {
    let set = target.get(key);
    if (!set) {
      set = new Set();
      target.set(key, set);
    }
    for (const value of values) {
      if (value) {
        set!.add(value);
      }
    }
  }
}

function normalizeMapKey(key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  return key.toLocaleLowerCase('en-US');
}

function indexEntityInMap<T>(
  map: Map<string, T>,
  entity: T,
  keys: {
    entityRef: string;
    dn?: string;
    rdn?: string;
    uuid?: string;
  },
) {
  map.set(keys.entityRef, entity);
  const dnKey = normalizeMapKey(keys.dn);
  if (dnKey) {
    map.set(dnKey, entity);
  }
  if (keys.rdn) {
    map.set(keys.rdn, entity);
  }
  if (keys.uuid) {
    map.set(keys.uuid, entity);
  }
}

/**
 * Helper function which looks up entities by entity ref, normalized DN, or
 * other indexed keys.
 */
function getValueFromMap<T>(map: Map<string, T>, searchValue: string) {
  const normalized = normalizeMapKey(searchValue);
  if (normalized) {
    const normalizedResult = map.get(normalized);
    if (normalizedResult) {
      return normalizedResult;
    }
  }
  return map.get(searchValue);
}

/**
 * Takes groups and entities with empty relations, and fills in the various
 * relations that were returned by the readers, and forms the org hierarchy.
 *
 * @param groups - Group entities with empty relations; modified in place
 * @param users - User entities with empty relations; modified in place
 * @param userMemberOf - For a user DN, the set of group DNs or UUIDs that the
 *        user is a member of
 * @param groupMemberOf - For a group DN, the set of group DNs or UUIDs that
 *        the group is a member of (parents in the hierarchy)
 * @param groupMember - For a group DN, the set of group DNs or UUIDs that are
 *        members of the group (children in the hierarchy)
 */
export function resolveRelations(
  groups: GroupEntity[],
  users: UserEntity[],
  userMemberOf: Map<string, Set<string>>,
  groupMemberOf: Map<string, Set<string>>,
  groupMember: Map<string, Set<string>>,
) {
  // Build reference lookup tables - all of the relations that are output from
  // the above calls can be expressed as either DNs or UUIDs so we need to be
  // able to find by both, as well as the entity reference. Note that we expect them to not
  // collide here - this is a reasonable assumption as long as the fields are
  // the supported forms.
  const userMap: Map<string, UserEntity> = new Map(); // by entityRef, dn, uuid
  const groupMap: Map<string, GroupEntity> = new Map(); // by entityRef, dn, uuid
  for (const user of users) {
    indexEntityInMap(userMap, user, {
      entityRef: stringifyEntityRef(user),
      dn: user.metadata.annotations![LDAP_DN_ANNOTATION],
      rdn: user.metadata.annotations![LDAP_RDN_ANNOTATION],
      uuid: user.metadata.annotations![LDAP_UUID_ANNOTATION],
    });
  }
  for (const group of groups) {
    indexEntityInMap(groupMap, group, {
      entityRef: stringifyEntityRef(group),
      dn: group.metadata.annotations![LDAP_DN_ANNOTATION],
      rdn: group.metadata.annotations![LDAP_RDN_ANNOTATION],
      uuid: group.metadata.annotations![LDAP_UUID_ANNOTATION],
    });
  }

  // Fill in all of the immediate relations, now keyed on the entity reference. We
  // keep all parents at this point, whether the target model can support more
  // than one or not (it gets filtered farther down). And group children are
  // only groups in here.
  const newUserMemberOf: Map<string, Set<string>> = new Map();
  const newGroupParents: Map<string, Set<string>> = new Map();
  const newGroupChildren: Map<string, Set<string>> = new Map();

  // Resolve and store in the intermediaries. It may seem redundant that the
  // input data has both parent and children directions, as well as both
  // user->group and group->user - the reason is that different LDAP schemas
  // express relations in different directions. Some may have a user memberOf
  // overlay, some don't, for example.
  for (const [userN, groupsN] of userMemberOf.entries()) {
    const user = getValueFromMap(userMap, userN);
    if (user) {
      for (const groupN of groupsN) {
        const group = getValueFromMap(groupMap, groupN);
        if (group) {
          ensureItems(newUserMemberOf, stringifyEntityRef(user), [
            stringifyEntityRef(group),
          ]);
        }
      }
    }
  }
  for (const [groupN, parentsN] of groupMemberOf.entries()) {
    const group = getValueFromMap(groupMap, groupN);
    if (group) {
      for (const parentN of parentsN) {
        const parentGroup = getValueFromMap(groupMap, parentN);
        if (parentGroup) {
          ensureItems(newGroupParents, stringifyEntityRef(group), [
            stringifyEntityRef(parentGroup),
          ]);
          ensureItems(newGroupChildren, stringifyEntityRef(parentGroup), [
            stringifyEntityRef(group),
          ]);
        }
      }
    }
  }
  for (const [groupN, membersN] of groupMember.entries()) {
    const group = getValueFromMap(groupMap, groupN);
    if (group) {
      for (const memberN of membersN) {
        // Group members can be both users and groups in the input model, so
        // try both
        const memberUser = getValueFromMap(userMap, memberN);
        if (memberUser) {
          ensureItems(newUserMemberOf, stringifyEntityRef(memberUser), [
            stringifyEntityRef(group),
          ]);
        } else {
          const memberGroup = getValueFromMap(groupMap, memberN);
          if (memberGroup) {
            ensureItems(newGroupChildren, stringifyEntityRef(group), [
              stringifyEntityRef(memberGroup),
            ]);
            ensureItems(newGroupParents, stringifyEntityRef(memberGroup), [
              stringifyEntityRef(group),
            ]);
          }
        }
      }
    }
  }

  // Write down the relations again into the actual entities
  for (const [userN, groupsN] of newUserMemberOf.entries()) {
    const user = getValueFromMap(userMap, userN);
    if (user) {
      user.spec.memberOf = Array.from(groupsN).sort();
    }
  }
  for (const [groupN, parentsN] of newGroupParents.entries()) {
    if (parentsN.size === 1) {
      const group = getValueFromMap(groupMap, groupN);
      if (group) {
        group.spec.parent = parentsN.values().next().value;
      }
    }
  }
  for (const [groupN, childrenN] of newGroupChildren.entries()) {
    const group = getValueFromMap(groupMap, groupN);
    if (group) {
      group.spec.children = Array.from(childrenN).sort();
    }
  }

  // Fill out the rest of the hierarchy
  buildOrgHierarchy(groups);
}
