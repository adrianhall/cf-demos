/**
 * @file Workers-runtime tests for the Detect Objects surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The geometry normaliser is covered against a fake inference port in
 *   the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { MAX_DETECTION_TARGET_LENGTH } from '../../src/shared/detect-objects';
import { DETECT_OBJECTS_BODY_LIMIT_BYTES } from '../../src/worker/routes/detect-objects';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The reviewed detection model.
 */
const MOONDREAM = '@cf/moondream/moondream3.1-9B-A2B';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-2222-4333-8444-555566667777';

/**
 * Builds a valid PNG, base64-encoded.
 *
 * Carries a real signature and a real IHDR chunk, because the Worker identifies the format from the
 * bytes and reads the dimensions from the header. A placeholder string would be refused.
 *
 * @param width Width to declare.
 * @param height Height to declare.
 * @returns The base64 PNG.
 */
function pngBase64(width = 64, height = 64): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);

  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

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
 * @param overrides Fields to replace or add.
 * @returns The body to send.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(),
    model: MOONDREAM,
    runId: RUN_ID,
    target: 'dog',
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Detect Objects route.
 *
 * @param email Identity to sign the token for.
 * @param payload Request body to send.
 * @param extraHeaders Additional headers, used to attempt header-based identity smuggling.
 * @returns A request ready to dispatch.
 */
async function postAs(
  email: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request('https://playground.example/api/detect-objects', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/detect-objects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Every Access application in a team shares a JWKS, so a token minted for an unrelated
  // application would be accepted without this check.
  it('refuses a token minted for another audience', async () => {
    const token = await signDevJwt('alice@example.com', { audience: 'b'.repeat(64) });
    const response = await send(
      new Request('https://playground.example/api/detect-objects', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Validation runs for an authenticated caller, so reaching a `400` proves the request got past
  // Access rather than being turned away at the edge.
  it('admits an authenticated caller to validation', async () => {
    const response = await send(await postAs('alice@example.com', { nonsense: true }));
    expect(response.status).toBe(400);
  });
});

describe('identity cannot be supplied by the caller', () => {
  // The actor is derived from the verified Access identity. A body field claiming to be someone
  // else is refused outright rather than ignored, so a caller cannot believe it was honoured.
  it.each(['user', 'email', 'actor', 'sub'])(
    'refuses an identity field %s in the body',
    async (field) => {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'mallory@example.com' }))
      );

      expect(response.status).toBe(400);
    }
  );

  // A header is the other place a caller might try. It must make no difference to who the run is
  // attributed to, and must not turn a valid request into a failure either.
  it('ignores an identity smuggled in a header', async () => {
    const response = await send(
      await postAs('alice@example.com', body(), {
        'cf-access-authenticated-user-email': 'mallory@example.com'
      })
    );

    // Validation passes, so the request reaches the inference boundary, which has no AI binding in
    // this harness. The point is that the header changed nothing about admission.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(400);
  });
});

describe('request validation at the deployed surface', () => {
  it('rejects a payload that is not a renderable image', async () => {
    const notAnImage = btoa('%PDF-1.7 this is not a picture');
    const response = await send(
      await postAs('alice@example.com', body({ imageBase64: notAnImage }))
    );

    expect(response.status).toBe(400);
  });

  // SVG is a scripting context rather than a picture, so it is refused even though it is an
  // image format a browser would happily render.
  it('rejects SVG markup', async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const response = await send(await postAs('alice@example.com', body({ imageBase64: svg })));

    expect(response.status).toBe(400);
  });

  it('rejects a picture beyond the pixel limit', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ imageBase64: pngBase64(8_192, 64) }))
    );

    expect(response.status).toBe(400);
  });

  // The target is the whole point of the panel, so a blank one is refused rather than being
  // defaulted to the model's own "person".
  it.each([
    ['empty', ''],
    ['whitespace', '   ']
  ])('rejects a %s target', async (_label, target) => {
    const response = await send(await postAs('alice@example.com', body({ target })));
    expect(response.status).toBe(400);
  });

  it('rejects a target beyond this demo\u2019s length limit', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ target: 'a'.repeat(MAX_DETECTION_TARGET_LENGTH + 1) })
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects an output limit outside the model\u2019s declared range', async () => {
    expect((await send(await postAs('alice@example.com', body({ maxObjects: 0 })))).status).toBe(
      400
    );
    expect((await send(await postAs('alice@example.com', body({ maxObjects: 501 })))).status).toBe(
      400
    );
  });

  // A detector locates a phrase; it has nothing to be instructed. Refusing the field tells a
  // caller who sent one that they have misunderstood the panel.
  it('rejects a generative field', async () => {
    for (const field of ['instruction', 'prompt', 'question', 'negativePrompt']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'draw a dog' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/microsoft/resnet-50' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(DETECT_OBJECTS_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/detect-objects', {
        method: 'POST',
        headers: {
          [JWT_HEADER]: token,
          'content-type': 'application/json',
          'content-length': String(oversized.length)
        },
        body: oversized
      })
    );

    expect(response.status).toBe(400);
  });
});

describe('problem details', () => {
  it('reports a validation failure as RFC 9457', async () => {
    const response = await send(await postAs('alice@example.com', body({ target: '' })));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');

    const problem = (await response.json()) as Record<string, unknown>;
    expect(typeof problem.title).toBe('string');
    expect(typeof problem.detail).toBe('string');
    expect(problem.status).toBe(400);
  });

  it('answers an unsupported method rather than treating it as a detection', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/detect-objects', {
        method: 'GET',
        headers: { [JWT_HEADER]: token }
      })
    );

    expect(response.status).toBe(404);
  });
});
