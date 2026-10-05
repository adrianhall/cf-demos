/**
 * @file Workers-runtime tests for the Read Text surface. These dispatch real requests through the
 *   real Worker in a real workerd isolate, which is the only way to prove that Access verification,
 *   the body limit, and the problem-details contract behave as deployed. No model is called: the
 *   `AI` binding is not available in this harness, so a request that passes validation fails at the
 *   inference boundary. That is deliberate — these tests cover the authenticated HTTP surface, the
 *   authorization outcomes, and the input rules, all of which are exercised fully without spending
 *   a cent. The per-model control rules and the audio output normaliser are covered against a fake
 *   inference port in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { MAX_SPEECH_CHARACTERS } from '../../src/shared/read-text';
import { READ_TEXT_BODY_LIMIT_BYTES } from '../../src/worker/routes/read-text';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed speech model.
 */
const AURA_2 = '@cf/deepgram/aura-2-en';

/**
 * The previous Aura generation, whose voice list differs from the default's.
 */
const AURA_1 = '@cf/deepgram/aura-1';

/**
 * The multilingual model, which has a language control and no voice control.
 */
const MELO = '@cf/myshell-ai/melotts';

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
 * @param overrides Fields to replace or add.
 * @returns The body to send.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { text: 'Hello there.', model: AURA_2, runId: RUN_ID, ...overrides };
}

/**
 * Builds an authenticated `POST` to the Read Text route.
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
  return new Request('https://playground.example/api/read-text', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/read-text', {
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
      new Request('https://playground.example/api/read-text', {
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
  it('rejects absent and empty text', async () => {
    expect((await send(await postAs('alice@example.com', body({ text: undefined })))).status).toBe(
      400
    );
    expect((await send(await postAs('alice@example.com', body({ text: '   ' })))).status).toBe(400);
  });

  it('rejects text beyond the character limit', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ text: 'a'.repeat(MAX_SPEECH_CHARACTERS + 1) }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a malformed run identifier', async () => {
    const response = await send(await postAs('alice@example.com', body({ runId: 'short' })));
    expect(response.status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/microsoft/resnet-50' }))
    );

    expect(response.status).toBe(400);
  });

  // The panel's defining rule, at the deployed surface. The same voice is published by one reviewed
  // model and not the other, so validation has to resolve it against the selected model rather than
  // against a fixed list for the panel.
  it('rejects a voice the selected model does not publish', async () => {
    const response = await send(await postAs('alice@example.com', body({ voice: 'angus' })));
    expect(response.status).toBe(400);
  });

  // The same request against the model that does publish that voice is valid, and therefore fails
  // later at the unavailable binding rather than at validation. That difference is the proof the
  // per-model resolution is really happening.
  it('accepts that same voice on the model that publishes it', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: AURA_1, voice: 'angus' }))
    );

    expect(response.status).not.toBe(400);
  });

  // Mutually exclusive control families: not merely out of range, but a field the schema does not
  // declare at all.
  it('rejects a language on a model that has no language control', async () => {
    const response = await send(await postAs('alice@example.com', body({ language: 'en' })));
    expect(response.status).toBe(400);
  });

  it('rejects a voice on a model that has no voice control', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MELO, voice: 'luna' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a language outside the published list', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MELO, language: 'xx' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a format the model does not offer', async () => {
    expect((await send(await postAs('alice@example.com', body({ format: 'flac' })))).status).toBe(
      400
    );
    expect(
      (await send(await postAs('alice@example.com', body({ model: MELO, format: 'mp3' })))).status
    ).toBe(400);
  });

  // No reviewed model exposes either control, and refusing them is what makes that finding visible
  // rather than silently discarding part of a caller's request.
  it('rejects rate and pitch', async () => {
    expect((await send(await postAs('alice@example.com', body({ rate: 1.5 })))).status).toBe(400);
    expect((await send(await postAs('alice@example.com', body({ pitch: 0.5 })))).status).toBe(400);
  });

  it('rejects a body over the size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(READ_TEXT_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/read-text', {
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

  it('answers a GET with a not-found rather than audio', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/read-text', {
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
  // The actor comes from the verified JWT claims alone, so a smuggled header changes nothing — the
  // request proceeds to the inference boundary exactly as it would without it.
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

  // The text is the visitor's content. An error that quoted it back would put it in one more place
  // — including any intermediary that logs response bodies.
  it('does not echo the submitted text back in an error', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ text: 'a confidential passage', voice: 'angus' }))
    );

    expect(await response.text()).not.toContain('a confidential passage');
  });
});

describe('the panel catalogue', () => {
  // The browser builds its selector and its controls from this response, so a panel listed
  // without a reviewed model would produce an empty selector in the deployed UI.
  it('advertises Read Text with reviewed models', async () => {
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
        provider: string;
        speechControls?: {
          textParameterName: string;
          voices?: string[];
          languages?: string[];
          pricePerThousandCharactersUsd?: number;
        };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'read-text');
    expect(task).toMatchObject({ gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'read-text');
    expect(models.length).toBeGreaterThan(0);

    // Every reviewed model is Cloudflare-hosted, which is why this panel could be delivered without
    // prepaid AI Gateway credit.
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
      expect(model.speechControls, `${model.id} publishes controls`).toBeDefined();
    }

    // The UI renders a voice selector or a language selector from these fields. Without them it
    // would have to guess, and would offer a control the provider rejects.
    const defaultModel = models[0];
    expect(defaultModel?.speechControls?.voices?.length).toBeGreaterThan(0);
    expect(defaultModel?.speechControls?.pricePerThousandCharactersUsd).toBeGreaterThan(0);
  });
});
