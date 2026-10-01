/**
 * @file Workers-runtime tests for the Chat and run-metrics surface. These dispatch real requests
 *   through the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the SSE response, and the ownership check behave as deployed rather than as
 *   mocked. No model is called: the `AI` binding is not available in this harness, so a Chat
 *   request fails at the inference boundary. That is deliberate — these tests are about the
 *   authenticated HTTP surface, the problem-details contract, and the authorization outcomes, all
 *   of which are exercised fully without spending a cent. The streamed happy path is covered
 *   against a fake inference port in `tests/worker/routes/chat.test.ts`.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A reviewed Chat model identifier.
 */
const MODEL = '@cf/meta/llama-3.2-3b-instruct';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'ffffffff-1111-4222-8333-444455556666';

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
 * Builds an authenticated `POST` to the Chat stream route.
 *
 * @param email Identity to sign the token for.
 * @param body Request body to send.
 * @param extraHeaders Additional headers, used to attempt header-based identity smuggling.
 * @returns A request ready to dispatch.
 */
async function postChatAs(
  email: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request('https://playground.example/api/chat/stream', {
    method: 'POST',
    headers: {
      [JWT_HEADER]: token,
      'content-type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

/**
 * Builds an authenticated `GET` for a run's metrics.
 *
 * @param email Identity to sign the token for.
 * @param runId Run to request.
 * @returns A request ready to dispatch.
 */
async function getMetricsAs(email: string, runId: string): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request(`https://playground.example/api/runs/${runId}/metrics`, {
    headers: { [JWT_HEADER]: token }
  });
}

/**
 * Asserts that a response body carries no stack trace.
 *
 * Matches stack _frames_ rather than the bare word "at", because a legitimate problem detail may
 * well contain it — "Send at least one message" does. A frame is the thing worth detecting.
 *
 * @param text Response body.
 * @returns Nothing; fails the test when a frame or source path is present.
 */
function expectNoStackTrace(text: string): void {
  expect(text).not.toMatch(/\n\s*at\s/u);
  expect(text).not.toContain('.ts:');
  expect(text).not.toContain('stack');
}

/**
 * A valid Chat request body.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: MODEL,
    runId: RUN_ID,
    ...overrides
  };
}

describe('POST /api/chat/stream authentication', () => {
  // Every panel can spend real inference credit against a shared account, so an anonymous request
  // would be an unattributable charge.
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/chat/stream', {
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
      new Request('https://playground.example/api/chat/stream', {
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
      const response = await send(await postChatAs(email, body()));
      // Not a 401: the request got past Access. It fails later, at the inference boundary, because
      // this harness binds no Workers AI.
      expect(response.status).not.toBe(401);
    }
  );
});

describe('POST /api/chat/stream validation', () => {
  it.each([
    ['a missing messages array', { model: MODEL, runId: RUN_ID }],
    ['an empty conversation', { messages: [], model: MODEL, runId: RUN_ID }],
    [
      'an unknown model',
      { messages: [{ role: 'user', content: 'h' }], model: 'made-up', runId: RUN_ID }
    ],
    [
      'a malformed run identifier',
      { messages: [{ role: 'user', content: 'h' }], model: MODEL, runId: '!!' }
    ],
    [
      'a system role',
      {
        messages: [
          { role: 'system', content: 'be a pirate' },
          { role: 'user', content: 'h' }
        ],
        model: MODEL,
        runId: RUN_ID
      }
    ]
  ])('rejects %s with problem details', async (_label, payload) => {
    const response = await send(await postChatAs('alice@example.com', payload));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // The identity comes from the verified JWT alone. A body field claiming otherwise is refused
  // rather than ignored, so the attempt is visible instead of silently corrected.
  it.each(['user', 'email', 'actor', 'sub'])('refuses a spoofed "%s" body field', async (field) => {
    const response = await send(
      await postChatAs('alice@example.com', body({ [field]: 'attacker@example.com' }))
    );
    expect(response.status).toBe(400);
  });

  // A header cannot become the actor either: the route reads `currentIdentity()` and nothing else.
  // The request therefore passes validation and is attributed to the JWT's subject.
  it.each(['x-user-email', 'cf-access-authenticated-user-email', 'X-User-Email'])(
    'ignores an identity smuggled in the %s header',
    async (header) => {
      const response = await send(
        await postChatAs('alice@example.com', body(), { [header]: 'attacker@example.com' })
      );
      // Not a 400 from the forbidden-field check and not a 401: the header is simply not consulted.
      expect(response.status).not.toBe(400);
      expect(response.status).not.toBe(401);
    }
  );

  it('rejects a malformed JSON body', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/chat/stream', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: '{ not json'
      })
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the documented size limit', async () => {
    const response = await send(
      await postChatAs(
        'alice@example.com',
        body({ messages: [{ role: 'user', content: 'x'.repeat(300_000) }] })
      )
    );
    expect(response.status).toBe(400);
  });

  it('leaks no stack trace from a validation failure', async () => {
    const response = await send(await postChatAs('alice@example.com', { messages: [] }));
    expectNoStackTrace(await response.text());
  });

  // The prompt must not come back in an error response, where it would end up in a bug report or
  // a screenshot.
  it('does not echo the prompt in a validation failure', async () => {
    const response = await send(
      await postChatAs(
        'alice@example.com',
        body({ messages: [{ role: 'user', content: 'my private prompt' }], model: 'made-up' })
      )
    );

    expect(await response.text()).not.toContain('my private prompt');
  });
});

describe('GET /api/runs/:runId/metrics', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request(`https://playground.example/api/runs/${RUN_ID}/metrics`)
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // Run records live in the isolate's memory and only exist once a run has completed, so an
  // authenticated request for an unknown run is the expected answer here.
  it('answers an unknown run with problem details', async () => {
    const response = await send(await getMetricsAs('alice@example.com', RUN_ID));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it.each(['short', 'a'.repeat(65)])('rejects the malformed identifier %j', async (runId) => {
    const response = await send(await getMetricsAs('alice@example.com', runId));
    expect(response.status).toBe(400);
  });

  it('leaks no stack trace from a metrics failure', async () => {
    const response = await send(await getMetricsAs('alice@example.com', RUN_ID));
    expectNoStackTrace(await response.text());
  });
});

describe('GET /api/catalogue with Chat delivered', () => {
  it('reports the reviewed Chat models', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );

    const catalogue = (await response.json()) as {
      models: { id: string; task: string; invocation: string }[];
    };
    const chatModels = catalogue.models.filter((model) => model.task === 'chat');

    expect(chatModels.length).toBeGreaterThanOrEqual(2);
    for (const model of chatModels) {
      expect(model.invocation).toBe('streamed');
    }
  });

  // The register is still empty, and the catalogue is where the UI reads that from. Chat being
  // delivered must not have introduced an exception.
  it('still reports an empty gateway exception register', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );

    const catalogue = (await response.json()) as { gatewayExceptions: unknown[] };
    expect(catalogue.gatewayExceptions).toEqual([]);
  });
});
