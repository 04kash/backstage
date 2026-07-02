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

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(),
}));

jest.mock('@octokit/webhooks', () => ({
  emitterEventNames: [
    'push',
    'pull_request',
    'pull_request.opened',
    'ping',
    'create',
    'delete',
  ],
}));

jest.mock('octokit-plugin-create-pull-request', () => {
  const DELETE_FILE = Symbol('DELETE_FILE');

  return {
    DELETE_FILE,
    createPullRequest: jest.fn(),
  };
});

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('octokit', () => ({
  Octokit: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@octokit/graphql', () => {
  function createGraphqlClient(
    defaults: {
      baseUrl?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return async function graphql(
      query: string,
      options: {
        variables?: Record<string, unknown>;
        headers?: Record<string, string>;
      } = {},
    ) {
      const baseUrl = defaults.baseUrl ?? 'https://api.github.com';
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...defaults.headers,
          ...options.headers,
        },
        body: JSON.stringify({
          query,
          variables: options.variables ?? options,
        }),
      });

      const body = await response.json();
      if (body.errors) {
        const error = new Error('GraphQL Error') as Error & {
          errors: unknown;
        };
        error.errors = body.errors;
        throw error;
      }

      return body.data;
    };
  }

  const graphql = Object.assign(createGraphqlClient(), {
    defaults: jest.fn().mockImplementation(createGraphqlClient),
  });

  return { graphql };
});

jest.mock('@octokit/plugin-throttling', () => ({
  throttling: jest.fn(),
}));

jest.mock('@octokit/plugin-retry', () => ({
  retry: jest.fn(),
}));

function createHookCollection() {
  const registry: Record<
    string,
    Array<(method: unknown, options: unknown) => unknown>
  > = {};

  return {
    bind(_null: null, name: string) {
      return (method: (options: unknown) => unknown, options: unknown) => {
        return Promise.resolve().then(() => {
          const hooks = registry[name];
          if (!hooks?.length) {
            return method(options);
          }
          return hooks.reduce(
            (nextMethod, registeredHook) =>
              registeredHook.bind(null, nextMethod, options),
            method,
          )();
        });
      };
    },
    wrap(
      name: string,
      wrapHook: (method: unknown, options: unknown) => unknown,
    ) {
      if (!registry[name]) {
        registry[name] = [];
      }
      registry[name].push(wrapHook);
    },
  };
}

jest.mock('@octokit/core', () => {
  function parseRequestOptions(
    route: string | Record<string, unknown>,
    parameters: Record<string, unknown> | undefined,
    baseUrl: string | undefined,
  ) {
    if (typeof route !== 'string') {
      return {
        headers: {},
        ...route,
        ...parameters,
        baseUrl: baseUrl ?? (route.baseUrl as string | undefined),
      };
    }

    const [method, ...urlParts] = route.split(' ');
    return {
      method,
      url: urlParts.join(' '),
      headers: {},
      ...parameters,
      baseUrl,
    };
  }

  async function performRequest(requestOptions: Record<string, any>) {
    const method = requestOptions.method || 'GET';
    let url = requestOptions.url || '';
    url = url.replace(/\{([^}]+)\}/g, (_: string, key: string) =>
      encodeURIComponent(requestOptions[key] ?? ''),
    );

    const baseUrl = requestOptions.baseUrl || 'https://api.github.com';
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

    const response = await fetch(fullUrl, {
      method,
      headers: requestOptions.headers,
    });

    const data = await response.json().catch(() => undefined);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (!response.ok) {
      const error = new Error(
        `Request failed with status ${response.status}`,
      ) as Error & {
        status: number;
        response: { data: unknown; headers: Record<string, string> };
      };
      error.status = response.status;
      error.response = { data, headers, status: response.status };
      throw error;
    }

    return { data, headers, status: response.status, url: fullUrl };
  }

  class Octokit {
    static plugins: Array<
      (octokit: Octokit, options: Record<string, unknown>) => unknown
    > = [];

    static plugin(
      ...newPlugins: Array<
        (octokit: Octokit, options: Record<string, unknown>) => unknown
      >
    ) {
      const currentPlugins = this.plugins;
      class PluginOctokit extends this {
        static plugins = currentPlugins.concat(
          newPlugins.filter(plugin => !currentPlugins.includes(plugin)),
        );
      }
      return PluginOctokit;
    }

    hook: ReturnType<typeof createHookCollection>;
    request: (
      route: string | Record<string, unknown>,
      parameters?: Record<string, unknown>,
    ) => Promise<unknown>;
    graphql: { defaults: jest.Mock };

    constructor(
      options: {
        baseUrl?: string;
        authStrategy?: (args: Record<string, unknown>) => {
          (): Promise<unknown>;
          hook: (
            request: (opts: Record<string, unknown>) => Promise<unknown>,
            hookOptions: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        throttle?: unknown;
        log?: unknown;
      } = {},
    ) {
      const hook = createHookCollection();
      this.hook = hook;

      const triggerRequest = hook.bind(null, 'request');

      this.request = (route, parameters) => {
        const requestOptions = parseRequestOptions(
          route,
          parameters,
          options.baseUrl,
        );
        return triggerRequest(performRequest, requestOptions);
      };

      this.graphql = {
        defaults: jest.fn().mockReturnValue(jest.fn()),
      };

      if (options.authStrategy) {
        const auth = options.authStrategy({
          request: this.request,
          log: options.log ?? {},
          octokit: this,
          octokitOptions: options,
        });
        hook.wrap('request', auth.hook);
        (this as { auth: typeof auth }).auth = auth;
      }

      const classConstructor = this.constructor as typeof Octokit;
      for (const plugin of classConstructor.plugins) {
        Object.assign(this, plugin(this, options));
      }
    }
  }

  return { Octokit };
});

export {};
