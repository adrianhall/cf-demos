/**
 * @file Workers-runtime tests for the Create Image surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface and the authorization outcomes, all of which are exercised fully without spending a
 *   cent. The happy path and the output-normalisation rules are covered against a fake inference
 *   port in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { CREATE_IMAGE_BODY_LIMIT_BYTES } from '../../src/worker/routes/create-image';

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A reviewed image model that exposes the full control set.
 */
const RICH_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';

/**
 * The reviewed image model that exposes only steps.
 */
const MINIMAL_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-1111-4222-8333-444455556666';

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Builds an authenticated `POST` to the Create Image route.
 *
 * @param email Identity to sign the token for.
 * @param body Request body to send.
 * @param extraHeaders Additional headers, used to attempt header-based identity smuggling.
 * @returns A request ready to dispatch.
 */
async function postAs(
  email: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request('https://playground.example/api/create-image', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
}

/**
 * A valid request body.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: 'a lighthouse', model: RICH_MODEL, runId: RUN_ID, ...overrides };
}

/**
 * Asserts that a response body carries no stack trace.
 *
 * Matches stack _frames_ rather than the bare word "at", because a legitimate problem detail may
 * well contain it.
 *
 * @param text Response body.
 * @returns Nothing; fails the test when a frame or source path is present.
 */
function expectNoStackTrace(text: string): void {
  expect(text).not.toMatch(/\n\s*at\s/u);
  expect(text).not.toContain('.ts:');
  expect(text).not.toContain('stack');
}

describe('POST /api/create-image authentication', () => {
  // Every panel can spend real inference credit against a shared account, so an anonymous request
  // would be an unattributable charge — and an image costs materially more than a chat answer.
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/create-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // Every Access application in a team shares one JWKS, so without an audience check a token
  // minted for an unrelated application would be accepted here too.
  it('refuses a token minted for a different Access application', async () => {
    const token = await signDevJwt('alice@example.com', { audience: 'b'.repeat(64) });
    const response = await send(
      new Request('https://playground.example/api/create-image', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  it.each(['alice@example.com', 'bob@example.com'])(
    'admits %s past authentication',
    async (email) => {
      const response = await send(await postAs(email, body()));
      // Not a 401: the request got past Access. It fails later, at the inference boundary, because
      // this harness binds no Workers AI.
      expect(response.status).not.toBe(401);
    }
  );
});

describe('POST /api/create-image validation', () => {
  it.each([
    ['a missing prompt', { model: RICH_MODEL, runId: RUN_ID }],
    ['an empty prompt', { prompt: '   ', model: RICH_MODEL, runId: RUN_ID }],
    ['an unknown model', { prompt: 'x', model: 'made-up', runId: RUN_ID }],
    ['a malformed run identifier', { prompt: 'x', model: RICH_MODEL, runId: '!!' }],
    [
      'a Chat model on the image panel',
      { prompt: 'x', model: '@cf/meta/llama-3.2-3b-instruct', runId: RUN_ID }
    ]
  ])('rejects %s with problem details', async (_label, payload) => {
    const response = await send(await postAs('alice@example.com', payload));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // The rule this phase exists to demonstrate, verified against the real reviewed descriptors
  // rather than test fixtures: FLUX.1 declares only `prompt` and `steps`.
  it.each(['negativePrompt', 'width', 'height', 'guidance', 'seed'])(
    'rejects "%s" against the model that does not declare it',
    async (control) => {
      const value = control === 'negativePrompt' ? 'people' : 512;
      const response = await send(
        await postAs('alice@example.com', body({ model: MINIMAL_MODEL, [control]: value }))
      );

      expect(response.status).toBe(400);
    }
  );

  it('rejects a step count above the selected model\u2019s ceiling', async () => {
    // Valid for Stable Diffusion XL, which allows 20; invalid for FLUX.1, which caps at 8.
    const response = await send(
      await postAs('alice@example.com', body({ model: MINIMAL_MODEL, steps: 20 }))
    );

    expect(response.status).toBe(400);
  });

  it('accepts that same step count on the model that allows it', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: RICH_MODEL, steps: 20 }))
    );

    // Past validation; it fails later at the inference boundary in this harness.
    expect(response.status).not.toBe(400);
  });

  it('names the model in an unsupported-control refusal', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MINIMAL_MODEL, seed: 1 }))
    );
    const problem = (await response.json()) as { detail: string };

    expect(problem.detail).toMatch(/FLUX/iu);
  });

  it.each(['user', 'email', 'actor', 'sub'])('refuses a spoofed "%s" body field', async (field) => {
    const response = await send(
      await postAs('alice@example.com', body({ [field]: 'attacker@example.com' }))
    );
    expect(response.status).toBe(400);
  });

  // A header cannot become the actor either: the route reads `currentIdentity()` and nothing else.
  it.each(['x-user-email', 'cf-access-authenticated-user-email', 'X-User-Email'])(
    'ignores an identity smuggled in the %s header',
    async (header) => {
      const response = await send(
        await postAs('alice@example.com', body(), { [header]: 'attacker@example.com' })
      );
      // Neither a 400 from the forbidden-field check nor a 401: the header is simply not consulted.
      expect(response.status).not.toBe(400);
      expect(response.status).not.toBe(401);
    }
  );

  it('rejects a malformed JSON body', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/create-image', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: '{ not json'
      })
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the documented size limit', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ prompt: 'x'.repeat(CREATE_IMAGE_BODY_LIMIT_BYTES) }))
    );
    expect(response.status).toBe(400);
  });

  it('leaks no stack trace from a validation failure', async () => {
    const response = await send(await postAs('alice@example.com', { prompt: '' }));
    expectNoStackTrace(await response.text());
  });

  // The prompt must not come back in an error response, where it would end up in a bug report or a
  // screenshot.
  it('does not echo the prompt in a validation failure', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ prompt: 'my private prompt', model: 'made-up' }))
    );

    expect(await response.text()).not.toContain('my private prompt');
  });
});

describe('GET /api/catalogue with Create Image delivered', () => {
  /**
   * Fetches the catalogue as an authenticated caller.
   *
   * @returns The decoded catalogue body.
   */
  async function fetchCatalogue() {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );
    return (await response.json()) as {
      models: {
        id: string;
        task: string;
        invocation: string;
        pricingUnit: string;
        imageControls?: Record<string, unknown>;
      }[];
      gatewayExceptions: unknown[];
    };
  }

  it('reports the reviewed image models', async () => {
    const catalogue = await fetchCatalogue();
    const imageModels = catalogue.models.filter((model) => model.task === 'create-image');

    expect(imageModels.length).toBeGreaterThanOrEqual(2);
    for (const model of imageModels) {
      expect(model.invocation).toBe('synchronous');
      expect(model.pricingUnit).toBe('image');
    }
  });

  // The browser builds its form from these, so a model published without them would render a panel
  // with no controls at all.
  it('publishes the control support of every image model', async () => {
    const catalogue = await fetchCatalogue();
    const imageModels = catalogue.models.filter((model) => model.task === 'create-image');

    for (const model of imageModels) {
      expect(model.imageControls, `${model.id} publishes its controls`).toBeDefined();
    }
  });

  it('publishes different control sets for the two image models', async () => {
    const catalogue = await fetchCatalogue();
    const rich = catalogue.models.find((model) => model.id === RICH_MODEL);
    const minimal = catalogue.models.find((model) => model.id === MINIMAL_MODEL);

    expect(rich?.imageControls?.['negativePrompt']).toBe(true);
    expect(minimal?.imageControls?.['negativePrompt']).toBe(false);
    expect(rich?.imageControls?.['dimensions']).toBeDefined();
    expect(minimal?.imageControls?.['dimensions']).toBeUndefined();
  });

  // Create Image needed no exception: its single call path is the gateway client, exactly as Chat's
  // is.
  it('reports only the documented FLUX multipart exception', async () => {
    expect((await fetchCatalogue()).gatewayExceptions).toEqual([
      expect.objectContaining({ id: 'flux-2-workers-ai-multipart-stream' })
    ]);
  });
});
