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
import {
  BackstageCredentials,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
  PolicyDecision,
  ResourcePermission,
} from '@backstage/plugin-permission-common';
import { SerializedTask } from '@backstage/plugin-scaffolder-node';

export type checkPermissionOptions = {
  credentials: BackstageCredentials;
  permissions: BasicPermission[];
  permissionService?: PermissionsService;
};

export type checkTaskPermissionOptions = {
  credentials: BackstageCredentials;
  permission: ResourcePermission;
  permissionService?: PermissionsService;
  task: SerializedTask;
  isTaskAuthorized: (
    decision: PolicyDecision,
    resource: SerializedTask | undefined,
  ) => boolean;
};

export type authorizeTasksOptions = {
  credentials: BackstageCredentials;
  permission: ResourcePermission;
  permissionService?: PermissionsService;
  tasks: SerializedTask[];
  isTaskAuthorized: (
    decision: PolicyDecision,
    resource: SerializedTask | undefined,
  ) => boolean;
};

/**
 * Does a basic check on permissions. Throws 403 error if any permission responds with AuthorizeResult.DENY
 * @public
 */
export async function checkPermission(options: checkPermissionOptions) {
  const { permissions, permissionService, credentials } = options;
  if (permissionService) {
    const permissionRequest = permissions.map(permission => ({
      permission,
    }));
    const authorizationResponses = await permissionService.authorize(
      permissionRequest,
      { credentials: credentials },
    );

    for (const response of authorizationResponses) {
      if (response.result === AuthorizeResult.DENY) {
        throw new NotAllowedError();
      }
    }
  }
}

/**
 * Does a conditional permission check for scaffolder task reading and cancellation.
 * Throws 403 error if permission responds with AuthorizeResult.DENY, or does not resolve to true during the conditional rule check
 * @public
 */
export async function checkTaskPermission(options: checkTaskPermissionOptions) {
  const { permission, permissionService, credentials, task, isTaskAuthorized } =
    options;
  if (permissionService) {
    const [taskDecision] = await permissionService.authorizeConditional(
      [{ permission: permission }],
      { credentials },
    );
    if (
      taskDecision.result === AuthorizeResult.DENY ||
      !isTaskAuthorized(taskDecision, task)
    ) {
      console.log(JSON.stringify(task));
      console.log(JSON.stringify(taskDecision));
      throw new NotAllowedError();
    }
  }
}

export async function authorizeTasks(options: authorizeTasksOptions) {
  const {
    permission,
    permissionService,
    credentials,
    tasks,
    isTaskAuthorized,
  } = options;

  const authorizedTasks: {
    tasks: SerializedTask[];
    totalTasks?: number;
  } = {
    tasks: [],
    totalTasks: 0,
  };

  if (permissionService) {
    const taskDecisions = await Promise.all(
      tasks.map(async task => {
        const [taskDecision] = await permissionService.authorizeConditional(
          [{ permission: permission }],
          { credentials },
        );
        return { task, taskDecision };
      }),
    );

    // Process task decisions
    taskDecisions.forEach(({ task, taskDecision }) => {
      console.log(JSON.stringify(task.createdBy));
      console.log(JSON.stringify(taskDecision));
      if (
        taskDecision.result === AuthorizeResult.ALLOW ||
        isTaskAuthorized(taskDecision, task)
      ) {
        authorizedTasks.tasks.push(task);
      }
    });

    authorizedTasks.totalTasks = authorizedTasks.tasks.length;
  }
  return authorizedTasks;
}
