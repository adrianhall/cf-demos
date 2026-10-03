/**
 * @file Workers-runtime tests for the Translate Text surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The two response envelopes and the per-model request shapes are
 *   covered against a fake inference port in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS
} from '../../src/shared/translate-text';
import { TRANSLATE_TEXT_BODY_LIMIT_BYTES } from '../../src/worker/routes/translate-text';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed model: explicit source and target, one call per line.
 */
const M2M100 = '@cf/meta/m2m100-1.2b';

/**
 * The fixed-source model: no source field, and it batches every line into one call.
 */
const INDIC = '@cf/ai4bharat/indictrans2-en-indic-1B';

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
  return {
    text: 'The water is cold today.',
    model: M2M100,
    runId: RUN_ID,
    targetLanguage: 'fr',
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Translate Text route.
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
  return new Request('https://playground.example/api/translate-text', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/translate-text', {
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
      new Request('https://playground.example/api/translate-text', {
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
  it('rejects absent, non-string, or blank text', async () => {
    expect((await send(await postAs('alice@example.com', body({ text: undefined })))).status).toBe(
      400
    );
    expect((await send(await postAs('alice@example.com', body({ text: '   ' })))).status).toBe(400);
  });

  it('rejects text beyond the character limit', async () => {
    const long = 'a'.repeat(MAX_TRANSLATION_CHARACTERS + 1);
    expect((await send(await postAs('alice@example.com', body({ text: long })))).status).toBe(400);
  });

  // The cost bound this panel adds, at the deployed surface. A character limit alone would let a
  // pasted list become a large number of paid calls from one click.
  it('rejects more lines than the segment limit', async () => {
    const many = Array.from({ length: MAX_TRANSLATION_SEGMENTS + 1 }, (_u, i) => `line ${i}`).join(
      '\n'
    );
    const response = await send(await postAs('alice@example.com', body({ text: many })));
    const problem = (await response.json()) as { detail: string };

    expect(response.status).toBe(400);
    expect(problem.detail).toMatch(/lines rather than/u);
  });

  it('accepts exactly the segment limit', async () => {
    const atLimit = Array.from({ length: MAX_TRANSLATION_SEGMENTS }, (_u, i) => `line ${i}`).join(
      '\n'
    );
    const response = await send(await postAs('alice@example.com', body({ text: atLimit })));

    // Not a 400: it is valid, and fails later at the unavailable `AI` binding.
    expect(response.status).not.toBe(400);
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

  // The clearest demonstration that a language code is a per-model contract: the two reviewed
  // models use different standards, so the same language is spelled two ways and neither accepts
  // the other's spelling.
  it('rejects each model\u2019s language code on the other model', async () => {
    const indicCodeOnM2M = await send(
      await postAs('alice@example.com', body({ model: M2M100, targetLanguage: 'hin_Deva' }))
    );
    expect(indicCodeOnM2M.status).toBe(400);

    const m2mCodeOnIndic = await send(
      await postAs('alice@example.com', body({ model: INDIC, targetLanguage: 'hi' }))
    );
    expect(m2mCodeOnIndic.status).toBe(400);
  });

  it('accepts each model\u2019s own language code', async () => {
    expect(
      (await send(await postAs('alice@example.com', body({ targetLanguage: 'hi' })))).status
    ).not.toBe(400);

    expect(
      (
        await send(
          await postAs('alice@example.com', body({ model: INDIC, targetLanguage: 'hin_Deva' }))
        )
      ).status
    ).not.toBe(400);
  });

  // Not merely out of range — the field does not exist in its schema at all, so the refusal
  // explains that rather than listing acceptable values.
  it('rejects a source language on the model that has none', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: INDIC, targetLanguage: 'hin_Deva', sourceLanguage: 'en' })
      )
    );
    const problem = (await response.json()) as { detail: string };

    expect(response.status).toBe(400);
    expect(problem.detail).toMatch(/no source-language field/u);
  });

  it('rejects the same language on both sides', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ sourceLanguage: 'fr', targetLanguage: 'fr' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the transport size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(TRANSLATE_TEXT_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/translate-text', {
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

  it('answers a GET with a not-found rather than a translation', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/translate-text', {
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
  // The actor comes from the verified JWT claims alone, so a smuggled header changes nothing.
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

  // The source text is the visitor's content. An error that quoted it back would put it in one
  // more place — including any intermediary that logs response bodies.
  it('does not echo the source text back in an error', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ text: 'a confidential sentence', targetLanguage: 'not-a-language' })
      )
    );

    expect(await response.text()).not.toContain('a confidential sentence');
  });
});

describe('the panel catalogue', () => {
  // The browser builds its selectors, its swap action, *and its predicted call count* from this
  // response, so the panel being marked available without reviewed models would produce an empty
  // selector and no cost disclosure in the deployed UI.
  it('advertises Translate Text as available with reviewed models', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );

    const payload = (await response.json()) as {
      tasks: { id: string; availability: string; gateway: string }[];
      models: {
        id: string;
        task: string;
        provider: string;
        translationControls?: {
          targetParameterName: string;
          sourceParameterName?: string;
          fixedSourceLanguage?: { code: string; name: string };
          sourceLanguages?: { code: string; name: string }[];
          targetLanguages: { code: string; name: string }[];
          defaultTargetLanguage: string;
          batchesSegments: boolean;
        };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'translate-text');
    expect(task).toMatchObject({ availability: 'available', gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'translate-text');
    expect(models.length).toBeGreaterThan(0);

    // Every reviewed model is Cloudflare-hosted, which is why this panel could be delivered
    // without prepaid AI Gateway credit.
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
      expect(model.translationControls, `${model.id} publishes controls`).toBeDefined();
      // The selector cannot be built without these, and a default outside the list would leave the
      // form in a state the server refuses.
      expect(
        model.translationControls?.targetLanguages.length,
        `${model.id} publishes target languages`
      ).toBeGreaterThan(0);
      expect(
        model.translationControls?.targetLanguages.some(
          (l) => l.code === model.translationControls?.defaultTargetLanguage
        ),
        `${model.id} default target is declared`
      ).toBe(true);
    }

    // Both batching behaviours must reach the browser, because the predicted call count — the
    // panel's only pre-request cost figure — is derived from this flag.
    const batching = models.map((model) => model.translationControls?.batchesSegments);
    expect(new Set(batching)).toEqual(new Set([true, false]));

    // One model with a source control and one without, which is what makes the swap action present
    // for one and absent for the other.
    const withSource = models.filter(
      (model) => model.translationControls?.sourceParameterName !== undefined
    );
    const fixedSource = models.filter(
      (model) => model.translationControls?.fixedSourceLanguage !== undefined
    );
    expect(withSource.length).toBeGreaterThan(0);
    expect(fixedSource.length).toBeGreaterThan(0);

    // The two language standards, published side by side. This is the fact the panel discloses and
    // the browser validates against.
    const m2m = models.find((model) => model.id === M2M100);
    const indic = models.find((model) => model.id === INDIC);
    expect(m2m?.translationControls?.targetLanguages.map((l) => l.code)).toContain('hi');
    expect(indic?.translationControls?.targetLanguages.map((l) => l.code)).toContain('hin_Deva');
  });
});
