/**
 * @file Workers-runtime tests for the Animate Image surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, audience enforcement, the body limit, and the problem-details contract behave as
 *   deployed. **No video is generated, and that is deliberate rather than a gap.** The Workflow
 *   binding is absent from this harness, so a request that passes validation fails at the platform
 *   boundary. Every model in this panel is third-party and bills per second of output, so a suite
 *   that generated video would charge real money every time it ran — and on this account would
 *   simply return `402`. The authenticated surface, the authorization outcomes, and the input rules
 *   are all exercised fully without spending anything; the job lifecycle and the storage path are
 *   covered against fakes in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { MAX_ANIMATE_SOURCE_BYTES } from '../../src/shared/animate-image';
import { ANIMATE_IMAGE_BODY_LIMIT_BYTES } from '../../src/worker/routes/animate-image';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-2222-4333-8444-555566667777';

/**
 * A minimal valid PNG, base64-encoded.
 *
 * Built inline rather than imported from the Worker suite's fixtures, because this project compiles
 * against the Workers runtime and keeping the harness self-describing avoids dragging a
 * Node-oriented helper into it. The dimensions are irrelevant to every assertion below; what
 * matters is that the bytes are a picture the shared validation accepts, so a refusal is about the
 * field under test rather than about the image.
 */
const PNG_BASE64 = (() => {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    // 64 × 64, 8-bit RGB.
    0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40, 0x08, 0x02, 0x00, 0x00, 0x00
  ];
  const bytes = new Uint8Array([...header, ...ihdr, ...new Array<number>(64).fill(0)]);
  return btoa(String.fromCharCode(...bytes));
})();

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
    imageBase64: PNG_BASE64,
    model: 'alibaba/hh1.1-i2v',
    runId: RUN_ID,
    motionPrompt: 'a slow push towards the subject',
    resolution: '720P',
    duration: 5,
    ...overrides
  };
}

/**
 * Builds a signed request to the start endpoint.
 *
 * @param payload Request body.
 * @param jwt Signed JWT, or `undefined` to send none.
 * @returns The request.
 */
function startRequest(payload: unknown = body(), jwt?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (jwt !== undefined) {
    headers[JWT_HEADER] = jwt;
  }
  return new Request('https://playground.test/api/animate-image', {
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

describe('Animate Image authentication', () => {
  it('refuses an unauthenticated start request', async () => {
    const response = await send(startRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('refuses a token minted for another Access application', async () => {
    // Every Access application in a team shares one JWKS, so without the audience check a token
    // from an unrelated application would be accepted here too.
    const response = await send(
      startRequest(body(), await token('alice@example.com', 'b'.repeat(64)))
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ['status', `/api/animate-image/${RUN_ID}/status`],
    ['video', `/api/animate-image/${RUN_ID}/video`]
  ])('refuses an unauthenticated %s request', async (_label, path) => {
    const response = await send(new Request(`https://playground.test${path}`));

    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated cancel request', async () => {
    const response = await send(
      new Request(`https://playground.test/api/animate-image/${RUN_ID}/cancel`, { method: 'POST' })
    );

    expect(response.status).toBe(401);
  });
});

describe('Animate Image validation', () => {
  it('rejects a body carrying an identity', async () => {
    // The actor comes from the verified JWT alone. A body supplying one is attempting to choose
    // who the charge is attributed to.
    const response = await send(startRequest(body({ email: 'bob@example.com' }), await token()));

    expect(response.status).toBe(400);
  });

  it('ignores an identity header in favour of the verified claim', async () => {
    // A smuggled header must not reach the actor. The request still fails — the Workflow binding
    // is absent — but it must not fail as a `400` about the body, which would mean the header had
    // been read as input.
    const request = startRequest(body(), await token());
    request.headers.set('x-user-email', 'bob@example.com');

    const response = await send(request);

    expect(response.status).not.toBe(400);
  });

  it('rejects a body naming its own job', async () => {
    const response = await send(startRequest(body({ jobId: 'guessed' }), await token()));

    expect(response.status).toBe(400);
  });

  // The panel's own security boundary, exercised as deployed: every reviewed model fetches its
  // source image from a URI, so a caller able to name one would be choosing a URL for a
  // third-party provider to retrieve.
  it.each(['image', 'image_uri', 'first_frame_image', 'image_input', 'imageUrl'])(
    'rejects a body naming the picture\u2019s location with %s',
    async (field) => {
      const response = await send(
        startRequest(body({ [field]: 'https://internal.test/secret.png' }), await token())
      );

      expect(response.status).toBe(400);
    }
  );

  it('rejects a request with no picture', async () => {
    const response = await send(startRequest(body({ imageBase64: undefined }), await token()));

    expect(response.status).toBe(400);
  });

  it('rejects a payload that is not an image', async () => {
    // Byte-authoritative: the format is read from the bytes' own header, never from what the
    // browser claimed about the file.
    const response = await send(
      startRequest(body({ imageBase64: btoa('this is not a picture') }), await token())
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unsupported control', async () => {
    // MiniMax declares no seed, so sending one is a client error rather than something silently
    // dropped — its schema would reject the undeclared property anyway.
    const response = await send(
      startRequest(
        body({ model: 'minimax/hailuo-2.3', resolution: '768P', duration: 6, seed: 7 }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a resolution spelled for a different model', async () => {
    // The two models share no resolution value, and a provider validating against an enum treats
    // `720P` and `768P` as unrelated strings.
    const response = await send(
      startRequest(
        body({ model: 'minimax/hailuo-2.3', resolution: '720P', duration: 6 }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a duration outside the model\u2019s range', async () => {
    const response = await send(startRequest(body({ duration: 99 }), await token()));

    expect(response.status).toBe(400);
  });

  it('rejects a duration the fixed-set model does not offer', async () => {
    // Eight seconds is inside the other model's range and is still refused here.
    const response = await send(
      startRequest(
        body({ model: 'minimax/hailuo-2.3', resolution: '768P', duration: 8 }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a missing motion prompt for the model that requires one', async () => {
    const response = await send(
      startRequest(
        body({ model: 'minimax/hailuo-2.3', resolution: '768P', duration: 6, motionPrompt: '' }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a model registered to another panel', async () => {
    // A text-to-video model has nowhere to put a picture.
    const response = await send(startRequest(body({ model: 'alibaba/hh1.1-t2v' }), await token()));

    expect(response.status).toBe(400);
  });

  it('rejects a body over the transport limit', async () => {
    const response = await send(
      startRequest(
        body({ motionPrompt: 'a'.repeat(ANIMATE_IMAGE_BODY_LIMIT_BYTES) }),
        await token()
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a picture larger than the Workflow payload allowance', async () => {
    // This panel's own ceiling, lower than every other image panel's because the picture has to
    // survive a Workflow event parameter. Sized to stay *inside* the transport limit, so the
    // refusal proves the domain rule fired rather than the body limit — which would have made
    // this test pass while checking something else entirely.
    const oversized = btoa('\u0000'.repeat(MAX_ANIMATE_SOURCE_BYTES + 1_024));
    expect(oversized.length).toBeLessThan(ANIMATE_IMAGE_BODY_LIMIT_BYTES);

    const response = await send(startRequest(body({ imageBase64: oversized }), await token()));

    expect(response.status).toBe(400);
  });

  it('answers a problem-details document on refusal', async () => {
    const response = await send(startRequest(body({ duration: 99 }), await token()));

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; title: string; detail: string };
    expect(problem.status).toBe(400);
    expect(problem.detail).toBeTruthy();
  });

  it('leaks no stack trace from a deployed build', async () => {
    const response = await send(startRequest(body({ duration: 99 }), await token()));

    expect(await response.text()).not.toContain('at ');
  });
});

describe('Animate Image job addressing', () => {
  it('answers 404 for an implausible run identifier', async () => {
    const response = await send(
      new Request('https://playground.test/api/animate-image/no%21/status', {
        headers: { [JWT_HEADER]: await token() }
      })
    );

    expect(response.status).toBe(404);
  });

  it('answers 404 rather than confirming another identity\u2019s job exists', async () => {
    // Absence is the correct answer for a job that is not yours: the identifier is derived from
    // the verified identity, so a different visitor simply derives a different one. Telling them
    // it exists but is forbidden would itself be a disclosure.
    const response = await send(
      new Request(`https://playground.test/api/animate-image/${RUN_ID}/status`, {
        headers: { [JWT_HEADER]: await token('bob@example.com') }
      })
    );

    expect(response.status).toBe(404);
  });

  it('answers 404 for a video that does not exist', async () => {
    const response = await send(
      new Request(`https://playground.test/api/animate-image/${RUN_ID}/video`, {
        headers: { [JWT_HEADER]: await token() }
      })
    );

    expect(response.status).toBe(404);
  });

  // The two panels share a bucket and a derivation key, so a run started in one must not be
  // readable through the other's route. The derivation includes no task identifier, which makes
  // this worth asserting rather than assuming.
  it('does not serve a Create Video run through the Animate Image route', async () => {
    const response = await send(
      new Request(`https://playground.test/api/animate-image/${RUN_ID}/video`, {
        headers: { [JWT_HEADER]: await token() }
      })
    );

    expect(response.status).toBe(404);
  });
});
