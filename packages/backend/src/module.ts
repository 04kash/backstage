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

import { CustomPermissionPolicy } from './policy';
import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { CatalogClient } from '@backstage/catalog-client';
import { coreServices } from '@backstage/backend-plugin-api';

export const permissionModuleANamePolicy = createBackendModule({
  pluginId: 'permission',
  moduleId: 'a-name-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, discovery: coreServices.discovery },
      async init({ policy, discovery }) {
        const catalogClient = new CatalogClient({ discoveryApi: discovery });
        policy.setPolicy(new CustomPermissionPolicy(catalogClient));
      },
    });
  },
});
