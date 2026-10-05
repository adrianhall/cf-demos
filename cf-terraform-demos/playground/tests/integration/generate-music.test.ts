/**
 * @file Workers-runtime tests for the Generate Music surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called, and on this panel that is worth being explicit about. The `AI` binding is not available
 *   in this harness, so a request that passes validation fails at the inference boundary — and even
 *   with a binding available, every reviewed music model is third-party and would bill against
 *   prepaid AI Gateway credits the test account does not have. These tests therefore cover the
 *   authenticated HTTP surface, the authorization outcomes, and the input rules, all of which are
 *   exercised in full without spending a cent. The per-model control rules, the output normaliser,
 *   and the audio URL policy are covered against fakes in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import {
  MAX_MUSIC_LENGTH_SECONDS,
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS,
  MIN_MUSIC_LENGTH_SECONDS
} from '../../src/shared/generate-music';
import { GENERATE_MUSIC_BODY_LIMIT_BYTES } from '../../src/worker/routes/generate-music';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed music model: per-second, with a length control and no lyrics field.
 */
const ELEVENLABS = 'elevenlabs/music-v2';

/**
 * The comparison model: per-track, with lyrics and no length control.
 */
const MINIMAX = 'minimax/music-2.6';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'e1e1e1e1-2222-4333-8444-555566667777';

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
    prompt: 'A warm cinematic ambient piece',
    model: ELEVENLABS,
    runId: RUN_ID,
    instrumental: true,
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Generate Music route.
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
  return new Request('https://playground.example/api/generate-music', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/generate-music', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Every Access application in a team shares a JWKS, so a token minted for an unrelated
  // application would be accepted without this check. That matters especially on a panel that spends
  // prepaid credit: an accepted foreign token would be an unattributable charge.
  it('refuses a token minted for another audience', async () => {
    const token = await signDevJwt('alice@example.com', { audience: 'b'.repeat(64) });
    const response = await send(
      new Request('https://playground.example/api/generate-music', {
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

  // A valid request reaches the inference boundary and fails there, which is how these tests prove a
  // request was accepted without spending anything. Not a `400`: the request itself is fine.
  it('admits a valid request as far as the model call', async () => {
    const response = await send(await postAs('alice@example.com', body()));
    expect(response.status).not.toBe(400);
  });
});

describe('request validation at the deployed surface', () => {
  it('rejects absent and empty prompts', async () => {
    expect(
      (await send(await postAs('alice@example.com', body({ prompt: undefined })))).status
    ).toBe(400);
    expect((await send(await postAs('alice@example.com', body({ prompt: '   ' })))).status).toBe(
      400
    );
  });

  it('rejects a prompt beyond the character limit', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ prompt: 'a'.repeat(MAX_MUSIC_PROMPT_CHARACTERS + 1) })
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a malformed run identifier', async () => {
    expect((await send(await postAs('alice@example.com', body({ runId: 'short' })))).status).toBe(
      400
    );
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/deepgram/aura-2-en' }))
    );

    expect(response.status).toBe(400);
  });

  // The panel's defining rule at the deployed surface, in both directions. The same field is a
  // legitimate control for one model and a property the other model's schema does not declare, so
  // validation has to resolve it against the selected model rather than against a fixed schema for
  // the panel.
  it('accepts a length for the model with a length control', async () => {
    const response = await send(await postAs('alice@example.com', body({ lengthSeconds: 30 })));
    expect(response.status).not.toBe(400);
  });

  it('rejects a length for the model with no length control', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MINIMAX, lengthSeconds: 30 }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a length outside the declared range', async () => {
    for (const lengthSeconds of [MIN_MUSIC_LENGTH_SECONDS - 1, MAX_MUSIC_LENGTH_SECONDS + 1, 0]) {
      const response = await send(await postAs('alice@example.com', body({ lengthSeconds })));
      expect(response.status, `length ${lengthSeconds}`).toBe(400);
    }
  });

  // The format enums share no value at all, so each model's default format is invalid for the other.
  // Both directions are asserted, since a loosened comparison would pass a one-sided test.
  it('rejects each model\u2019s format on the other model', async () => {
    expect((await send(await postAs('alice@example.com', body({ format: 'mp3' })))).status).toBe(
      400
    );
    expect(
      (
        await send(
          await postAs('alice@example.com', body({ model: MINIMAX, format: 'mp3_44100_128' }))
        )
      ).status
    ).toBe(400);
  });

  it('accepts each model\u2019s own format', async () => {
    expect(
      (await send(await postAs('alice@example.com', body({ format: 'mp3_44100_192' })))).status
    ).not.toBe(400);
    expect(
      (await send(await postAs('alice@example.com', body({ model: MINIMAX, format: 'wav' }))))
        .status
    ).not.toBe(400);
  });

  it('rejects lyrics for the model with no lyrics field', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ instrumental: false, lyrics: 'la la la' }))
    );

    expect(response.status).toBe(400);
  });

  it('accepts lyrics for the model that declares them', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: MINIMAX, instrumental: false, lyrics: 'line one' })
      )
    );

    expect(response.status).not.toBe(400);
  });

  it('rejects lyrics beyond the character limit', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({
          model: MINIMAX,
          instrumental: false,
          lyrics: 'a'.repeat(MAX_MUSIC_LYRICS_CHARACTERS + 1)
        })
      )
    );

    expect(response.status).toBe(400);
  });

  // The provider's own refusal, reimplemented locally so it happens before the charge. On a
  // per-track model that is the difference between a free `400` and fifteen cents.
  it('rejects a vocal track with no words for the model that requires them', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MINIMAX, instrumental: false }))
    );

    expect(response.status).toBe(400);
  });

  // The same state is valid for the model that describes vocals in the prompt, which is what proves
  // the rule is read from the descriptor rather than applied to the panel.
  it('accepts a vocal track with no words for the model that does not require them', async () => {
    const response = await send(await postAs('alice@example.com', body({ instrumental: false })));
    expect(response.status).not.toBe(400);
  });

  it('rejects supplying lyrics and asking the model to write them at once', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: MINIMAX, instrumental: false, lyrics: 'line one', generateLyrics: true })
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects lyrics on an instrumental track', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: MINIMAX, instrumental: true, lyrics: 'line one' })
      )
    );

    expect(response.status).toBe(400);
  });

  it('rejects a seed for the model that accepts none', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: MINIMAX, format: 'mp3', seed: 1_234 }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(GENERATE_MUSIC_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/generate-music', {
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

  it('answers a GET with a not-found rather than a track', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/generate-music', {
        headers: { [JWT_HEADER]: token }
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('fields the caller may not supply', () => {
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

  // These describe the *output*, which the server establishes from the bytes it received. `audio`
  // and `audioUrl` matter most: they are the shape of an attempt to have this Worker fetch an
  // arbitrary URL, which is the one thing the host allowlist exists to prevent.
  it('rejects a body describing the output it expects back', async () => {
    for (const field of ['audio', 'audioUrl', 'mediaType', 'byteLength', 'durationSeconds']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'https://evil.example/track.mp3' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  // A header is the other route by which a caller might try to choose who a run — and its charge —
  // is attributed to. The actor comes from the verified JWT claims alone, so a smuggled header
  // changes nothing and the request proceeds to the inference boundary exactly as it would without
  // it.
  it('ignores an identity smuggled in a header', async () => {
    const response = await send(
      await postAs('alice@example.com', body(), {
        'cf-access-authenticated-user-email': 'mallory@example.com',
        'x-forwarded-user': 'mallory@example.com'
      })
    );

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

  // The prompt and the lyrics are the visitor's content. An error that quoted either back would put
  // it in one more place, including any intermediary that logs response bodies.
  it('does not echo the prompt or the lyrics back in an error', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({
          model: MINIMAX,
          instrumental: true,
          prompt: 'a confidential brief',
          lyrics: 'secret words here'
        })
      )
    );

    const text = await response.text();
    expect(text).not.toContain('a confidential brief');
    expect(text).not.toContain('secret words here');
  });
});

describe('the panel catalogue', () => {
  // The browser builds its selector, its controls, and its cost sentences from this response, so a
  // panel listed without reviewed models would produce an empty selector in the deployed UI.
  it('advertises Generate Music with reviewed models', async () => {
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
        pricingUnit: string;
        invocation: string;
        musicControls?: {
          formats: string[];
          lengthSeconds?: { min: number; max: number; default: number };
          lyrics: string;
          outputHosts: string[];
          pricing: { unit: string };
        };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'generate-music');
    expect(task).toMatchObject({ gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'generate-music');
    expect(models.length).toBeGreaterThanOrEqual(2);

    // Every model is third-party, which is the catalogue fact that made this the first
    // credit-dependent panel. The UI reads it to explain why there is no hosted fallback.
    for (const model of models) {
      expect(model.provider, `${model.id} is third-party`).toBe('third-party');
      expect(model.musicControls, `${model.id} publishes controls`).toBeDefined();
      // Synchronous, which is why this panel has one route rather than Create Video's four.
      expect(model.invocation, `${model.id} invocation`).toBe('synchronous');
      // Never a token price: neither model reports a token count, and a token label would invite
      // exactly the derivation this panel exists to rule out.
      expect(model.pricingUnit, `${model.id} pricing unit`).not.toBe('token');
      expect(model.musicControls?.outputHosts.length, `${model.id} hosts`).toBeGreaterThan(0);
    }

    // The two billing units the panel compares, published before any run so the browser can quote an
    // estimate rather than waiting for a charge.
    expect(models.map((model) => model.musicControls?.pricing.unit).sort()).toEqual([
      'audio-second',
      'track'
    ]);

    // The capability difference the panel renders its controls from: one model has a length control
    // and the other genuinely does not.
    const withLength = models.filter((model) => model.musicControls?.lengthSeconds !== undefined);
    expect(withLength).toHaveLength(1);

    const withLyrics = models.filter((model) => model.musicControls?.lyrics === 'optional');
    expect(withLyrics).toHaveLength(1);
  });
});
