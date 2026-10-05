/**
 * @file Workers-runtime tests for the Classify Image surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The ranking rules and the output normaliser are covered against a fake
 *   inference port in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { CLASSIFY_IMAGE_BODY_LIMIT_BYTES } from '../../src/worker/routes/classify-image';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The reviewed classifier.
 */
const RESNET = '@cf/microsoft/resnet-50';

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
    model: RESNET,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Classify Image route.
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
  return new Request('https://playground.example/api/classify-image', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/classify-image', {
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
      new Request('https://playground.example/api/classify-image', {
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

  it('rejects a control outside the model\u2019s declared range', async () => {
    expect((await send(await postAs('alice@example.com', body({ topK: 99 })))).status).toBe(400);
    expect(
      (await send(await postAs('alice@example.com', body({ minimumConfidence: 5 })))).status
    ).toBe(400);
  });

  // A classifier has nothing to be asked. Refusing the field tells a caller who sent one that
  // they have misunderstood the panel, rather than letting them believe it was honoured.
  it('rejects a generative field', async () => {
    for (const field of ['instruction', 'prompt', 'question', 'negativePrompt']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'what is this' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/llava-hf/llava-1.5-7b-hf' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(CLASSIFY_IMAGE_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/classify-image', {
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

  it('answers a GET with a not-found rather than a classification', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/classify-image', {
        headers: { [JWT_HEADER]: token }
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('identity cannot be supplied by the caller', () => {
  // The body is refused outright rather than having the field stripped, so a caller learns their
  // attempt was noticed instead of believing it worked.
  it('rejects a body carrying an identity field', async () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'mallory@example.com' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  // A header is the other route by which a caller might try to choose who a run is attributed to.
  // The actor comes from the verified JWT claims alone, so a smuggled header changes nothing —
  // the request proceeds to the inference boundary exactly as it would without it.
  it('ignores an identity smuggled in a header', async () => {
    const response = await send(
      await postAs('alice@example.com', body(), {
        'cf-access-authenticated-user-email': 'mallory@example.com',
        'x-forwarded-user': 'mallory@example.com'
      })
    );

    // Not a 400: the request is valid. It fails later, at the unavailable `AI` binding.
    expect(response.status).not.toBe(400);
  });

  it('rejects a body describing its own image', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ mediaType: 'image/png', width: 10 }))
    );

    expect(response.status).toBe(400);
  });
});

describe('error responses', () => {
  it('answers a validation failure as RFC 9457 problem details', async () => {
    const response = await send(await postAs('alice@example.com', { nonsense: true }));

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; title: string; detail: string };
    expect(problem.status).toBe(400);
    expect(problem.detail).toBeTruthy();
  });

  // A deployed build must never emit a stack trace: `includeStack` is gated on
  // `import.meta.env.DEV`, which Vite replaces with a literal `false` in production.
  it('leaks no stack trace', async () => {
    const text = await (await send(await postAs('alice@example.com', { nonsense: true }))).text();

    expect(text).not.toMatch(/\n\s*at\s/u);
    expect(text).not.toContain('.ts:');
  });

  it('does not echo the submitted picture back in an error', async () => {
    const payload = body({ topK: 99 });
    const text = await (await send(await postAs('alice@example.com', payload))).text();

    expect(text).not.toContain(payload['imageBase64'] as string);
  });
});

describe('the panel catalogue', () => {
  // The browser builds its selector and its controls from this response, so a panel
  // listed without a reviewed model would produce an empty selector in the deployed UI.
  it('advertises Classify Image with a reviewed classifier', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );

    const payload = (await response.json()) as {
      tasks: {
        id: string;
        gateway: string;
        hosting: { cloudflare: boolean; thirdParty: boolean };
      }[];
      models: {
        id: string;
        task: string;
        classificationControls?: { appliedBy: string; topK?: { max: number } };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'classify-image');
    expect(task).toMatchObject({ gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'classify-image');
    expect(models.length).toBeGreaterThan(0);
    // The UI reads `appliedBy` to describe the controls honestly. Without it the panel would
    // imply the model was asked to rank, which it was not.
    expect(models[0]?.classificationControls?.appliedBy).toBe('playground');
  });
});
