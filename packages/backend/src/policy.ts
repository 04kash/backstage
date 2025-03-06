/*
 * Copyright 2025 The Backstage Authors
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
  AuthorizeResult,
  isPermission,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  createScaffolderTaskConditionalDecision,
  scaffolderTaskConditions,
} from '@backstage/plugin-scaffolder-backend/alpha';
import { taskReadPermission } from '@backstage/plugin-scaffolder-common/alpha';
import { CatalogClient } from '@backstage/catalog-client';

// Define a type guard function
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
export class CustomPermissionPolicy implements PermissionPolicy {
  private readonly catalogClient: CatalogClient;

  constructor(catalogClient: CatalogClient) {
    this.catalogClient = catalogClient;
  }

  async getUserOwnedTemplates(userRef: string): Promise<string[]> {
    if (!userRef) return [];

    const response = await this.catalogClient.getEntities({
      filter: {
        kind: ['Template'],
        'relations.ownedBy': [userRef],
      },
    });

    return response.items.map(item => item.metadata.name);
  }

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    if (isPermission(request.permission, taskReadPermission)) {
      const userOwnedTemplates = await this.getUserOwnedTemplates(
        user?.info.userEntityRef || '',
      );
      const templateEntityRefs = userOwnedTemplates.map(
        name => `template:default/${name}`,
      );

      return createScaffolderTaskConditionalDecision(request.permission, {
        anyOf: [
          scaffolderTaskConditions.hasCreatedBy({
            createdBy: [user?.info.userEntityRef, ''].filter(isDefined),
          }),
          scaffolderTaskConditions.hasTemplateEntityRefs({
            // This should be dynamically determined, e.g. via a catalog call,
            // so that it includes all template entity refs that the user owns.
            templateEntityRefs: templateEntityRefs,
          }),
        ],
      });
    }
    return { result: AuthorizeResult.ALLOW };
  }
}
