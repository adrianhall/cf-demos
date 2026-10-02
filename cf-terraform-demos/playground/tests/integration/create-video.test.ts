/**
 * @file Workers-runtime tests for the Create Video surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, audience enforcement, the body limit, and the problem-details contract behave as
 *   deployed. No video is generated: the Workflow and R2 bindings are absent from this harness, so
 *   a request that passes validation fails at the platform boundary. That is deliberate and it is
 *   the right trade — this panel's model calls bill per second of output, so a suite that generated
 *   video would charge real money every time it ran. The authenticated surface, the authorization
 *   outcomes, and the input rules are all exercised fully without spending anything; the job
 *   lifecycle and the storage path are covered against fakes in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { CREATE_VIDEO_BODY_LIMIT_BYTES } from '../../src/worker/routes/create-video';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-2222-4333-8444-555566667777';

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
 * Builds a valid request body.
 *
 * @param overrides Fields to replace.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'A dog running through tall grass',
    model: 'pixverse/v6',
    runId: RUN_ID,
    resolution: '360p',
    duration: 5,
    ...overrides
  };
}

/**
 * Builds a signed request to the start endpoint.
 *
 * @param payload Request body.
 * @param token Signed JWT, or `undefined` to send none.
 * @returns The request.
 */
async function startRequest(payload: unknown = body(), token?: string): Promise<Request> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers[JWT_HEADER] = token;
  }
  return new Request('https://playground.test/api/create-video', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
}

/**
 * Signs a development JWT for the given identity and audience.
 *
 * @param email Identity to sign for.
 * @param aud Audience to claim.
 * @returns The signed token.
 */
async function token(email = 'alice@example.com', aud = AUD): Promise<string> {
  return await signDevJwt(email, { audience: aud });
}

describe('Create Video authentication', () => {
  it('refuses an unauthenticated start request', async () => {
    const response = await send(await startRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('refuses a token minted for another Access application', async () => {
    // Every Access application in a team shares one JWKS, so without the audience check a token
    // from an unrelated application would be accepted here too.
    const response = await send(
      await startRequest(body(), await token('alice@example.com', 'b'.repeat(64)))
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ['status', `/api/create-video/${RUN_ID}/status`],
    ['video', `/api/create-video/${RUN_ID}/video`]
  ])('refuses an unauthenticated %s request', async (_label, path) => {
    const response = await send(new Request(`https://playground.test${path}`));

    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated cancel request', async () => {
    const response = await send(
      new Request(`https://playground.test/api/create-video/${RUN_ID}/cancel`, { method: 'POST' })
    );

    expect(response.status).toBe(401);
  });
});

describe('Create Video validation', () => {
  it('rejects a body carrying an identity', async () => {
    // The actor comes from the verified JWT alone. A body supplying one is attempting to choose who
    // the charge is attributed to.
    const response = await send(
      await startRequest(body({ email: 'bob@example.com' }), await token())
    );

    expect(response.status).toBe(400);
  });

  it('ignores an identity header in favour of the verified claim', async () => {
    // A smuggled header must not reach the actor. The request still fails — the platform bindings
    // are absent — but it must not fail as a `400` about the body, which would mean the header had
    // been read as input.
    const request = await startRequest(body(), await token());
    request.headers.set('x-user-email', 'bob@example.com');

    const response = await send(request);

    expect(response.status).not.toBe(400);
  });

  it('rejects a body naming its own job', async () => {
    const response = await send(await startRequest(body({ jobId: 'guessed' }), await token()));

    expect(response.status).toBe(400);
  });

  it('rejects an unsupported control', async () => {
    // Alibaba declares no negative prompt, so sending one is a client error rather than something
    // silently dropped.
    const response = await send(
      await startRequest(
        body({ model: 'alibaba/hh1.1-t2v', negativePrompt: 'blurry' }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a resolution spelled for a different model', async () => {
    const response = await send(
      await startRequest(body({ model: 'alibaba/hh1.1-t2v', resolution: '720p' }), await token())
    );

    expect(response.status).toBe(400);
  });

  it('rejects a duration outside the model’s range', async () => {
    const response = await send(await startRequest(body({ duration: 99 }), await token()));

    expect(response.status).toBe(400);
  });

  it('rejects a model registered to another panel', async () => {
    const response = await send(
      await startRequest(body({ model: '@cf/microsoft/resnet-50' }), await token())
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the transport limit', async () => {
    // There is no media going *in* to this panel, so the limit is small and a body shaped like an
    // upload is refused before validation sees it.
    const response = await send(
      await startRequest(body({ prompt: 'a'.repeat(CREATE_VIDEO_BODY_LIMIT_BYTES) }), await token())
    );

    expect(response.status).toBe(400);
  });

  it('answers a problem-details document on refusal', async () => {
    const response = await send(await startRequest(body({ duration: 99 }), await token()));

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; title: string; detail: string };
    expect(problem.status).toBe(400);
    expect(problem.detail).toBeTruthy();
  });

  it('leaks no stack trace from a deployed build', async () => {
    const response = await send(await startRequest(body({ duration: 99 }), await token()));

    expect(await response.text()).not.toContain('at ');
  });
});

describe('Create Video job addressing', () => {
  it('answers 404 for an implausible run identifier', async () => {
    const response = await send(
      new Request('https://playground.test/api/create-video/not-a-run/status', {
        headers: { [JWT_HEADER]: await token() }
      })
    );

    expect(response.status).toBe(404);
  });

  it('answers 404 rather than confirming another identity’s job exists', async () => {
    // Absence is the correct answer for a job that is not yours: the identifier is derived from the
    // verified identity, so a different visitor simply derives a different one. Telling them it
    // exists but is forbidden would itself be a disclosure.
    const response = await send(
      new Request(`https://playground.test/api/create-video/${RUN_ID}/status`, {
        headers: { [JWT_HEADER]: await token('bob@example.com') }
      })
    );

    expect(response.status).toBe(404);
  });

  it('answers 404 for a video that does not exist', async () => {
    const response = await send(
      new Request(`https://playground.test/api/create-video/${RUN_ID}/video`, {
        headers: { [JWT_HEADER]: await token() }
      })
    );

    expect(response.status).toBe(404);
  });
});
