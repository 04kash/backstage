/*
 * Copyright 2022 The Backstage Authors
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

jest.mock(
  '@octokit/webhooks-methods',
  () => {
    const { createHmac, timingSafeEqual } = require('node:crypto');

    async function sign(secret: string, payload: string) {
      const algorithm = 'sha256';
      return `${algorithm}=${createHmac(algorithm, secret)
        .update(payload)
        .digest('hex')}`;
    }

    async function verify(
      secret: string,
      eventPayload: string,
      signature: string,
    ) {
      const signatureBuffer = Buffer.from(signature);
      const verificationBuffer = Buffer.from(await sign(secret, eventPayload));
      if (signatureBuffer.length !== verificationBuffer.length) {
        return false;
      }
      return timingSafeEqual(signatureBuffer, verificationBuffer);
    }

    return { sign, verify };
  },
  { virtual: true },
);

import { ConfigReader } from '@backstage/config';
import {
  RequestDetails,
  RequestRejectionDetails,
  RequestValidationContext,
} from '@backstage/plugin-events-node';
import { sign } from '@octokit/webhooks-methods';
import { createGithubSignatureValidator } from './createGithubSignatureValidator';
import { OctokitProviderService } from '../util/octokitProviderService';

class TestContext implements RequestValidationContext {
  #details?: Partial<RequestRejectionDetails>;

  reject(details?: Partial<RequestRejectionDetails>): void {
    this.#details = details;
  }

  get details() {
    return this.#details;
  }
}

const octokitProvider = {
  getOctokit: jest.fn(),
} satisfies OctokitProviderService;

describe('createGithubSignatureValidator', () => {
  const secret = 'valid-secret';
  const configWithoutSecret = new ConfigReader({});
  const configWithSecret = new ConfigReader({
    events: {
      modules: {
        github: {
          webhookSecret: secret,
        },
      },
    },
  });
  const configWithAppSecret = new ConfigReader({
    integrations: {
      github: [
        {
          host: 'github.com',
          apps: [
            {
              appId: 7,
              privateKey: 'a',
              clientId: 'b',
              clientSecret: 'c',
              webhookSecret: secret,
            },
          ],
        },
      ],
    },
  });
  const payload = {
    test: 'payload',
    score: 5.0,
    repository: { html_url: 'https://github.com/backstage/backstage' },
    installation: { id: 70 },
  };
  const payloadString = JSON.stringify(payload);
  const payloadBuffer = Buffer.from(payloadString);
  const validSignature = sign(secret, payloadString);

  const requestWithSignature = async (signature: string | undefined) => {
    return {
      body: payload,
      headers: {
        'x-hub-signature-256': signature,
      },
      raw: {
        body: payloadBuffer,
        encoding: 'utf-8',
      },
    } as RequestDetails;
  };

  it('should return undefined if no secret is configured', async () => {
    expect(
      createGithubSignatureValidator(configWithoutSecret, octokitProvider),
    ).toEqual(undefined);
  });

  it('secret configured, reject request without signature', async () => {
    const request = await requestWithSignature(undefined);
    const context = new TestContext();

    const validator = createGithubSignatureValidator(
      configWithSecret,
      octokitProvider,
    );
    await validator!(request, context);

    expect(context.details).not.toBeUndefined();
    expect(context.details?.status).toBe(403);
    expect(context.details?.payload).toEqual({ message: 'invalid signature' });
  });

  it('secret configured, reject request with invalid signature', async () => {
    const request = await requestWithSignature('invalid signature');
    const context = new TestContext();

    const validator = createGithubSignatureValidator(
      configWithSecret,
      octokitProvider,
    );
    await validator!(request, context);

    expect(context.details).not.toBeUndefined();
    expect(context.details?.status).toBe(403);
    expect(context.details?.payload).toEqual({ message: 'invalid signature' });
  });

  it('secret configured, accept request with valid signature', async () => {
    const request = await requestWithSignature(await validSignature);
    const context = new TestContext();

    const validator = createGithubSignatureValidator(
      configWithSecret,
      octokitProvider,
    );
    await validator!(request, context);

    expect(context.details).toBeUndefined();
  });

  it('secret configured, accept request with valid signature defined in integrations', async () => {
    const request = await requestWithSignature(await validSignature);
    const context = new TestContext();
    octokitProvider.getOctokit.mockResolvedValue({
      rest: {
        apps: {
          getInstallation: async () => ({
            data: { app_id: 7 },
          }),
        },
      },
    });

    const validator = createGithubSignatureValidator(
      configWithAppSecret,
      octokitProvider,
    );
    await validator!(request, context);

    expect(context.details).toBeUndefined();
  });
});
