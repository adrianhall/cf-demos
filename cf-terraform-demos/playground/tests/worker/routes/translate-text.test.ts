import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  type TranslateTextResponse
} from '../../../src/shared/translate-text';
import { TranslateTextService } from '../../../src/worker/application/translate-text/translate-text-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  TRANSLATE_TEXT_BODY_LIMIT_BYTES,
  translateTextRouter
} from '../../../src/worker/routes/translate-text';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed translation models, in catalogue order.
 */
const [M2M100, INDIC] = modelsForTask('translate-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Mounts the Translate Text router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to the single-string envelope.
 * @param identity Verified identity to present.
 * @returns The app, the fake inference port, and the captured logs.
 */
function mount(
  options: FakeInferenceOptions = {},
  identity: { email: string; sub: string } | undefined = IDENTITY
): {
  app: ReturnType<typeof mountRoute>['app'];
  inference: FakeInference;
  logs: LogCapture;
} {
  const inference = new FakeInference({
    output: () => ({ translated_text: 'une traduction' }),
    ...options
  });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new TranslateTextService({
    inference,
    runs: createMemoryRunRepository(now),
    logger,
    now
  });

  const mounted = mountRoute('/api/translate-text', translateTextRouter, {
    identity,
    translateTextService: service,
    logger
  });
  mounted.app.onError(problemDetailsErrorHandler({ includeStack: false }));

  return { app: mounted.app, inference, logs: capture };
}

/**
 * Builds a request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'The water is cold today.',
    model: M2M100!.id,
    runId: RUN_ID,
    targetLanguage: 'fr',
    ...overrides
  };
}

/**
 * Posts a body to the route.
 *
 * @param app The mounted app.
 * @param payload Body to send.
 * @returns The response.
 */
async function post(
  app: ReturnType<typeof mountRoute>['app'],
  payload: unknown
): Promise<Response> {
  return app.request('/api/translate-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('translating a passage', () => {
  it('returns the translation, a receipt, and the applied controls', async () => {
    const response = await post(mount().app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as TranslateTextResponse;
    expect(payload.translation.text).toBe('une traduction');
    expect(payload.receipt.runId).toBe(RUN_ID);
    expect(payload.applied).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'fr' });
  });

  it('returns the aligned source and translated lines', async () => {
    const { app } = mount({ output: () => ({ translated_text: 'x' }) });
    const payload = (await (
      await post(app, body({ text: 'one\n\ntwo' }))
    ).json()) as TranslateTextResponse;

    expect(payload.translation.segments.map((s) => s.source)).toEqual(['one', '', 'two']);
    expect(payload.translation.segments[1]?.blank).toBe(true);
  });

  // Asserted at the route because this is the boundary a new control would be added at.
  it('sends the target language under the selected model\u2019s own field name', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(inference.requests[0]?.input).toMatchObject({ target_lang: 'fr' });
  });

  it('sends no source field at all to the fixed-source model', async () => {
    const { app, inference } = mount({ output: () => ({ translations: ['एक'] }) });
    await post(app, body({ model: INDIC!.id, targetLanguage: 'hin_Deva' }));

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(input).toMatchObject({ target_language: 'hin_Deva' });
    expect(input).not.toHaveProperty('source_lang');
  });
});

describe('the variable cost of one request', () => {
  // The panel's defining behaviour, at the HTTP boundary: the same passage is one billed call or
  // one per line depending purely on the selected model's contract.
  it('makes one call per line for one model and one call for the other', async () => {
    const perLine = mount();
    await post(perLine.app, body({ text: 'one\ntwo\nthree' }));
    expect(perLine.inference.requests).toHaveLength(3);

    const batched = mount({ output: () => ({ translations: ['A', 'B', 'C'] }) });
    await post(
      batched.app,
      body({ model: INDIC!.id, targetLanguage: 'hin_Deva', text: 'one\ntwo\nthree' })
    );
    expect(batched.inference.requests).toHaveLength(1);
  });

  it('reports the call count it actually made', async () => {
    const { app } = mount();
    const payload = (await (
      await post(app, body({ text: 'one\ntwo' }))
    ).json()) as TranslateTextResponse;

    expect(payload.translation.inferenceCallCount).toBe(2);
    expect(payload.applied.inferenceCallCount).toBe(2);
  });

  // The first panel whose receipt routinely carries several log identifiers, which is what keeps
  // the aggregated cost honest.
  it('returns one gateway log identifier per call', async () => {
    const { app } = mount({ logId: 'log-x' });
    const payload = (await (
      await post(app, body({ text: 'one\ntwo\nthree' }))
    ).json()) as TranslateTextResponse;

    expect(payload.receipt.logIds).toHaveLength(3);
    expect(payload.receipt.costStatus).toBe('pending');
  });
});

describe('rejected requests', () => {
  it('rejects a body carrying an identity field', async () => {
    expect((await post(mount().app, body({ email: 'mallory@example.com' }))).status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    expect((await post(mount().app, body({ model: '@cf/deepgram/aura-2-en' }))).status).toBe(400);
  });

  it('rejects empty text', async () => {
    expect((await post(mount().app, body({ text: '   ' }))).status).toBe(400);
  });

  it('rejects text beyond the character limit', async () => {
    const long = 'a'.repeat(MAX_TRANSLATION_CHARACTERS + 1);
    expect((await post(mount().app, body({ text: long }))).status).toBe(400);
  });

  // The cost bound, at the HTTP boundary. A character limit alone would let a pasted list become a
  // large number of paid calls from one click.
  it('rejects more lines than the segment limit', async () => {
    const many = Array.from({ length: MAX_TRANSLATION_SEGMENTS + 1 }, (_u, i) => `line ${i}`).join(
      '\n'
    );
    const response = await post(mount().app, body({ text: many }));

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/lines rather than/u);
  });

  it('refuses before making any call when the line limit is exceeded', async () => {
    const many = Array.from({ length: MAX_TRANSLATION_SEGMENTS + 5 }, (_u, i) => `l${i}`).join(
      '\n'
    );
    const { app, inference } = mount();
    await post(app, body({ text: many }));

    expect(inference.requests).toHaveLength(0);
  });

  // The clearest demonstration that a language code is a per-model contract: the same language,
  // spelled each model's way, is accepted by exactly one of them.
  it('rejects the other model\u2019s spelling of a language', async () => {
    expect((await post(mount().app, body({ targetLanguage: 'hin_Deva' }))).status).toBe(400);

    const batched = mount({ output: () => ({ translations: ['एक'] }) });
    expect(
      (await post(batched.app, body({ model: INDIC!.id, targetLanguage: 'hin_Deva' }))).status
    ).toBe(200);
  });

  it('rejects a source language on the model that has no source field', async () => {
    const response = await post(
      mount().app,
      body({ model: INDIC!.id, targetLanguage: 'hin_Deva', sourceLanguage: 'en' })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/no source-language field/u);
  });

  it('rejects the same language on both sides', async () => {
    expect(
      (await post(mount().app, body({ sourceLanguage: 'fr', targetLanguage: 'fr' }))).status
    ).toBe(400);
  });

  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way.
  it('refuses a body beyond the transport limit', async () => {
    const { app } = mount();
    const oversized = 'x'.repeat(TRANSLATE_TEXT_BODY_LIMIT_BYTES + 1_024);
    const response = await app.request('/api/translate-text', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(oversized.length)
      },
      body: oversized
    });

    expect(response.status).toBe(400);
  });

  // Derived from the character ceiling rather than hard-coded, so raising that limit cannot
  // silently leave this behind. Four bytes per character is the UTF-8 worst case — and this is the
  // first panel where that matters in practice, because the target scripts really do use three and
  // four bytes per character.
  it('sizes the body limit to hold the longest accepted text', () => {
    expect(TRANSLATE_TEXT_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_TRANSLATION_CHARACTERS * 4);
  });

  it('returns a sanitised 502 when the provider fails', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });

    expect((await post(app, body())).status).toBe(502);
  });

  it('returns a 502 when the provider returns an unusable envelope', async () => {
    const { app } = mount({ output: () => ({ unexpected: 'envelope' }) });
    expect((await post(app, body())).status).toBe(502);
  });

  // A third-party translation model added later would make this reachable. The classification
  // already works because it is decided in the inference client, below this route.
  it('passes through a 503 when gateway credit is insufficient', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail: 'This model uses prepaid AI Gateway credits.'
      })
    });

    expect((await post(app, body())).status).toBe(503);
  });

  it('leaks neither provider internals nor a stack trace', async () => {
    const { app } = mount({
      failWith: new Error('upstream: host internal-host-7 rejected "my secret"')
    });
    const text = await (await post(app, body())).text();

    expect(text).not.toContain('my secret');
    expect(text).not.toContain('internal-host-7');
    expect(text).not.toMatch(/\n\s*at\s/u);
  });
});

describe('diagnostics', () => {
  it('logs the attempt before calling the model', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const started = logs.entries.find((entry) => entry.message === 'translate_text_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: M2M100!.id,
      sourceLanguage: 'en',
      targetLanguage: 'fr'
    });
  });

  // The figure that makes this panel's cost legible before the fact. A run that disappears without
  // a trace here is a charge without an explanation.
  it('records how many calls the request intends to make', async () => {
    const { app, logs } = mount();
    await post(app, body({ text: 'one\ntwo\nthree' }));

    const started = logs.entries.find((entry) => entry.message === 'translate_text_run_started');
    expect(started?.context).toMatchObject({
      lineCount: 3,
      translatableLineCount: 3,
      plannedCalls: 3
    });
  });

  it('records a single planned call for the batching model', async () => {
    const { app, logs } = mount({ output: () => ({ translations: ['A', 'B'] }) });
    await post(app, body({ model: INDIC!.id, targetLanguage: 'hin_Deva', text: 'one\ntwo' }));

    const started = logs.entries.find((entry) => entry.message === 'translate_text_run_started');
    expect(started?.context?.['plannedCalls']).toBe(1);
  });

  // Null rather than omitted, so a log search for the key does not imply a bug when the model
  // simply has no source control.
  it('records a null source language for the fixed-source model', async () => {
    const { app, logs } = mount({ output: () => ({ translations: ['एक'] }) });
    await post(app, body({ model: INDIC!.id, targetLanguage: 'hin_Deva' }));

    const started = logs.entries.find((entry) => entry.message === 'translate_text_run_started');
    expect(started?.context?.['sourceLanguage']).toBeNull();
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'translate_text_run_started')).toBe(true);
    expect(logs.entries.some((entry) => entry.message === 'translate_text_run_failed')).toBe(true);
  });

  // Two requests that look identical in an access log have to be distinguishable in the structured
  // logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) => entry.message.startsWith('translate_text_run'));
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  it('records the call count on success', async () => {
    const { app, logs } = mount();
    await post(app, body({ text: 'one\ntwo' }));

    const completed = logs.entries.find(
      (entry) => entry.message === 'translate_text_run_completed'
    );
    expect(completed?.context).toMatchObject({
      inferenceCallCount: 2,
      logCount: 2,
      translatedLineCount: 2
    });
  });

  // Written as "must not contain", because that is the direction that silently rots: a field added
  // later would pass a positive assertion while breaking this one.
  it('never logs the source text, the translation, or the verified email', async () => {
    const { app, logs } = mount({ output: () => ({ translated_text: 'ma traduction' }) });
    await post(app, body({ text: 'my confidential sentence' }));

    expect(logs.text()).not.toContain('my confidential sentence');
    expect(logs.text()).not.toContain('ma traduction');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });
});

describe('identity', () => {
  // The attribution rule, asserted where it would actually be broken. A body field cannot reach
  // the gateway, because the domain refuses the body outright and the actor is assembled from the
  // verified claims alone.
  it('attributes the run to the verified identity rather than anything in the body', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(inference.requests[0]?.actor).toEqual(IDENTITY);
  });
});
