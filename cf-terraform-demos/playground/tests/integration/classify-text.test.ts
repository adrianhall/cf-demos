/**
 * @file Workers-runtime tests for the Classify Text surface. These dispatch real requests through
 *   the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The two response shapes are covered against a fake inference port in
 *   the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { MAX_CLASSIFICATION_TEXT_CHARACTERS } from '../../src/shared/classify-text';
import { CLASSIFY_TEXT_BODY_LIMIT_BYTES } from '../../src/worker/routes/classify-text';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed model: a genuine fixed-label classifier that scores its labels.
 */
const DISTILBERT = '@cf/huggingface/distilbert-sst-2-int8';

/**
 * The safety model: a verdict with no scores, and no ranking controls.
 */
const LLAMA_GUARD = '@cf/meta/llama-guard-3-8b';

/**
 * A decision model used as fixed-label classification through the Worker's immutable schema.
 */
const CLEF_FLASH = '@cf/cloudflare/clef-flash';

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
    text: 'The staff were wonderful and the food arrived quickly.',
    model: DISTILBERT,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Classify Text route.
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
  return new Request('https://playground.example/api/classify-text', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/classify-text', {
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
      new Request('https://playground.example/api/classify-text', {
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

/**
 * The regression guard the phase brief asks for, at the deployed surface.
 *
 * This is the boundary that keeps Classify Text distinct from Evaluate Choices, so it is worth
 * proving in the real runtime rather than only against a mounted router.
 */
describe('caller-defined criteria are rejected by this task', () => {
  it('rejects a caller-supplied label set under any plausible spelling', async () => {
    const attempts: Record<string, unknown> = {
      labels: ['urgent', 'not urgent'],
      label: 'urgent',
      categories: ['billing', 'technical'],
      category: 'billing',
      classes: ['a', 'b'],
      candidateLabels: ['spam', 'ham'],
      candidate_labels: ['spam', 'ham'],
      criteria: 'is this urgent?',
      question: 'is this urgent?',
      questions: [{ kind: 'noul', text: 'is this urgent?' }],
      choices: ['yes', 'no'],
      taxonomy: 'my-own-taxonomy',
      hypothesis: 'This text is about billing.'
    };

    for (const [field, value] of Object.entries(attempts)) {
      const response = await send(await postAs('alice@example.com', body({ [field]: value })));
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  it('explains that the labels belong to the model and names the other panel', async () => {
    const response = await send(await postAs('alice@example.com', body({ labels: ['urgent'] })));
    const problem = (await response.json()) as { detail: string };

    expect(problem.detail).toMatch(/cannot be supplied by the caller/u);
    expect(problem.detail).toMatch(/Evaluate Choices/u);
  });

  // The two panels must not share an API surface. A request shaped for Evaluate Choices is not
  // partially honoured here.
  it('rejects an Evaluate Choices-shaped request outright', async () => {
    const response = await send(
      await postAs('alice@example.com', {
        text: 'The customer wants a refund.',
        model: DISTILBERT,
        runId: RUN_ID,
        questions: [{ kind: 'choice', text: 'Which queue?', choices: ['billing', 'technical'] }]
      })
    );

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
    const long = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS + 1);
    expect((await send(await postAs('alice@example.com', body({ text: long })))).status).toBe(400);
  });

  it('accepts text exactly at the limit', async () => {
    const atLimit = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS);
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
      await postAs('alice@example.com', body({ model: '@cf/meta/m2m100-1.2b' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a ranking control outside the declared range', async () => {
    expect((await send(await postAs('alice@example.com', body({ topK: 0 })))).status).toBe(400);
    expect(
      (await send(await postAs('alice@example.com', body({ minimumConfidence: 2 })))).status
    ).toBe(400);
  });

  // The per-model capability rule: there is no score in this model's output for the control to
  // act on, so it is refused rather than accepted and dropped.
  it('rejects a ranking control on the model that reports no scores', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: LLAMA_GUARD, topK: 1 }))
    );
    const problem = (await response.json()) as { detail: string };

    expect(response.status).toBe(400);
    expect(problem.detail).toMatch(/nothing to rank or filter/u);
  });

  it('accepts Clef Flash with no caller-defined criteria', async () => {
    const response = await send(await postAs('alice@example.com', body({ model: CLEF_FLASH })));

    // Not a 400: it is valid, and fails later at the unavailable `AI` binding.
    expect(response.status).not.toBe(400);
  });

  it('accepts the verdict model with no controls', async () => {
    const response = await send(await postAs('alice@example.com', body({ model: LLAMA_GUARD })));

    expect(response.status).not.toBe(400);
  });

  it('rejects a body over the transport size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(CLASSIFY_TEXT_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/classify-text', {
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
      new Request('https://playground.example/api/classify-text', {
        headers: { [JWT_HEADER]: token }
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('identity cannot be supplied by the caller', () => {
  it('rejects a body carrying an identity field', async () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'mallory@example.com' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  // A header is the other route by which a caller might try to choose who a run is attributed to.
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

  // The text is the visitor's content. An error that quoted it back would put it in one more
  // place — including any intermediary that logs response bodies.
  it('does not echo the text back in an error', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ text: 'a confidential sentence', topK: 99 }))
    );

    expect(await response.text()).not.toContain('a confidential sentence');
  });
});

describe('the panel catalogue', () => {
  // The browser builds its label-set disclosure, its controls, *and its choice of renderer* from
  // this response, so the panel being marked available without reviewed models would produce an
  // empty selector and no result rendering in the deployed UI.
  it('advertises Classify Text as available with reviewed models', async () => {
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
        textClassificationControls?: {
          outcomeKind: string;
          inputShape: string;
          labelSetName: string;
          labelSet: { code: string; name: string }[];
          topK?: { default: number };
          minimumConfidence?: { default: number };
          appliedBy: string;
          contextWindowTokens?: number;
          requiresJsonResponseFormat?: boolean;
        };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'classify-text');
    expect(task).toMatchObject({ availability: 'available', gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'classify-text');
    expect(models).toHaveLength(3);

    // Every reviewed model is Cloudflare-hosted, which is why this panel could be delivered
    // without prepaid AI Gateway credit.
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
      expect(model.textClassificationControls, `${model.id} publishes controls`).toBeDefined();
      // The label-set disclosure is the panel's central teaching device and cannot be built
      // without this.
      expect(
        model.textClassificationControls?.labelSet.length,
        `${model.id} publishes its label set`
      ).toBeGreaterThan(0);
      expect(
        model.textClassificationControls?.labelSetName,
        `${model.id} names its label set`
      ).toBeTruthy();
      // Neither model filters server-side, and the UI states that rather than implying the model
      // was asked to.
      expect(model.textClassificationControls?.appliedBy, model.id).toBe('playground');
    }

    // Both outcome kinds must reach the browser, because the result renderer is chosen from this
    // flag — a panel that assumed a score would render `NaN%` against a valid verdict.
    const kinds = models.map((model) => model.textClassificationControls?.outcomeKind);
    expect(new Set(kinds)).toEqual(new Set(['scored-labels', 'verdict']));

    // Ranking controls on the scoring model and none on the verdict model, which is what makes
    // the controls appear for one and not the other.
    const scoring = models.find(
      (model) => model.textClassificationControls?.outcomeKind === 'scored-labels'
    );
    const verdict = models.find(
      (model) => model.textClassificationControls?.outcomeKind === 'verdict'
    );
    expect(scoring?.textClassificationControls?.topK).toBeDefined();
    expect(verdict?.textClassificationControls?.topK).toBeUndefined();
    expect(verdict?.textClassificationControls?.minimumConfidence).toBeUndefined();

    // The two label sets, published side by side: a binary sentiment pair and the hazard
    // taxonomy. This is the fact the panel discloses before any run.
    const distil = models.find((model) => model.id === DISTILBERT);
    const guard = models.find((model) => model.id === LLAMA_GUARD);
    expect(distil?.textClassificationControls?.labelSet.map((l) => l.code)).toEqual([
      'POSITIVE',
      'NEGATIVE'
    ]);
    const clef = models.find((model) => model.id === CLEF_FLASH);
    expect(clef?.textClassificationControls?.labelSet.map((label) => label.code)).toEqual([
      'POSITIVE',
      'NEGATIVE',
      'NEUTRAL'
    ]);
    expect(clef?.textClassificationControls?.inputShape).toBe('clef-choice');

    expect(guard?.textClassificationControls?.labelSet).toHaveLength(14);
    expect(guard?.textClassificationControls?.labelSet.map((l) => l.code)).toContain('S10');
    // The category AI Gateway Guardrails does not evaluate, which this model can still emit.
    expect(guard?.textClassificationControls?.labelSet.map((l) => l.code)).toContain('S14');
    // Without this the model answers in prose and every run of it fails.
    expect(guard?.textClassificationControls?.requiresJsonResponseFormat).toBe(true);
  });
});
