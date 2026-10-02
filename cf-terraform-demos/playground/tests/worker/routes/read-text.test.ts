import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_SPEECH_CHARACTERS, type ReadTextResponse } from '../../../src/shared/read-text';
import { ReadTextService } from '../../../src/worker/application/read-text/read-text-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { READ_TEXT_BODY_LIMIT_BYTES, readTextRouter } from '../../../src/worker/routes/read-text';
import { mp3WithId3Bytes, rawPcmBytes, streamOf, wavBytes } from '../support/audio-fixtures';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed speech models, in catalogue order.
 */
const [AURA_2, AURA_1, MELO] = modelsForTask('read-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Mounts the Read Text router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to a streamed MP3.
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
    output: () => streamOf(mp3WithId3Bytes()),
    ...options
  });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new ReadTextService({
    inference,
    runs: createMemoryRunRepository(now),
    logger,
    now
  });

  const mounted = mountRoute('/api/read-text', readTextRouter, {
    identity,
    readTextService: service,
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
  return { text: 'Hello there.', model: AURA_2!.id, runId: RUN_ID, ...overrides };
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
  return app.request('/api/read-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('reading text aloud', () => {
  it('returns the audio, a receipt, and the applied controls', async () => {
    const response = await post(mount().app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ReadTextResponse;
    expect(payload.speech.mediaType).toBe('audio/mpeg');
    expect(payload.speech.base64.length).toBeGreaterThan(0);
    expect(payload.receipt.runId).toBe(RUN_ID);
    expect(payload.applied).toMatchObject({ model: AURA_2!.id, voice: 'luna' });
  });

  it('reports the controls it applied, including the model defaults', async () => {
    const payload = (await (await post(mount().app, body())).json()) as ReadTextResponse;

    expect(payload.applied).toMatchObject({
      voice: AURA_2!.speechControls?.defaultVoice,
      format: AURA_2!.speechControls?.defaultFormat
    });
  });

  it('reports a cost estimate for a character-priced model', async () => {
    const payload = (await (
      await post(mount().app, body({ text: 'a'.repeat(1_000) }))
    ).json()) as ReadTextResponse;

    expect(payload.applied.estimatedCostUsd).toBeCloseTo(0.03, 6);
  });

  // Absent rather than zero, because the billable quantity does not exist until the audio does. A
  // zero would read as "free".
  it('omits the estimate for a model billed per minute of audio', async () => {
    const payload = (await (
      await post(mount().app, body({ model: MELO!.id }))
    ).json()) as ReadTextResponse;

    expect(payload.applied.estimatedCostUsd).toBeUndefined();
  });

  it('serves a WAV when that format is requested', async () => {
    const { app } = mount({ output: () => streamOf(wavBytes(1), 4_096) });
    const payload = (await (await post(app, body({ format: 'wav' }))).json()) as ReadTextResponse;

    expect(payload.speech.mediaType).toBe('audio/wav');
  });

  // Asserted at the route because this is the boundary a new control would be added at. Only fields
  // the selected model declares may reach the provider.
  it('sends only the fields the selected model declares', async () => {
    const { app, inference } = mount();
    await post(app, body({ voice: 'zeus', format: 'mp3' }));

    expect(Object.keys(inference.requests[0]?.input as Record<string, unknown>)).toEqual([
      'text',
      'speaker',
      'encoding'
    ]);
  });

  it('renames the text field for the model that spells it differently', async () => {
    const { app, inference } = mount();
    await post(app, body({ model: MELO!.id }));

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(input).toMatchObject({ prompt: 'Hello there.' });
    expect(input).not.toHaveProperty('text');
  });
});

describe('rejected requests', () => {
  it('rejects a body carrying an identity field', async () => {
    expect((await post(mount().app, body({ email: 'mallory@example.com' }))).status).toBe(400);
  });

  it('rejects empty text', async () => {
    expect((await post(mount().app, body({ text: '   ' }))).status).toBe(400);
  });

  it('rejects text beyond the character limit', async () => {
    const response = await post(mount().app, body({ text: 'a'.repeat(MAX_SPEECH_CHARACTERS + 1) }));
    expect(response.status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await post(mount().app, body({ model: '@cf/microsoft/resnet-50' }));
    expect(response.status).toBe(400);
  });

  // The per-model rule, at the HTTP boundary. The same voice is accepted by one reviewed model and
  // refused by another, and the refusal names the model so a caller knows which to switch to.
  it('rejects a voice the selected model does not publish', async () => {
    expect((await post(mount().app, body({ voice: 'angus' }))).status).toBe(400);
    expect((await post(mount().app, body({ model: AURA_1!.id, voice: 'angus' }))).status).toBe(200);
  });

  it('rejects a language on a model with no language control', async () => {
    expect((await post(mount().app, body({ language: 'en' }))).status).toBe(400);
  });

  it('rejects a voice on a model with no voice control', async () => {
    expect((await post(mount().app, body({ model: MELO!.id, voice: 'luna' }))).status).toBe(400);
  });

  // Rejected rather than silently dropped. No reviewed model has either control, and saying so is
  // the finding.
  it('rejects rate and pitch, which no reviewed model supports', async () => {
    expect((await post(mount().app, body({ rate: 1.5 }))).status).toBe(400);
    expect((await post(mount().app, body({ pitch: 0.5 }))).status).toBe(400);
  });

  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way.
  it('refuses a body beyond the size limit', async () => {
    const { app } = mount();
    const response = await app.request('/api/read-text', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(READ_TEXT_BODY_LIMIT_BYTES + 1_024)
      },
      body: 'x'.repeat(READ_TEXT_BODY_LIMIT_BYTES + 1_024)
    });

    expect(response.status).toBe(400);
  });

  // Derived from the character limit rather than compared against a hard-coded size, so changing
  // the limit cannot leave this assertion pinned to the old number. Four bytes per character covers
  // the widest UTF-8 encoding.
  it('sizes the body limit to hold the longest accepted passage', () => {
    expect(READ_TEXT_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_SPEECH_CHARACTERS * 4);
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

  it('returns a 502 when the provider returns unplayable data', async () => {
    const { app } = mount({ output: () => streamOf(rawPcmBytes()) });
    expect((await post(app, body())).status).toBe(502);
  });

  // A third-party speech model added later would make this reachable. The classification already
  // works because it is decided in the inference client, below this route.
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
    await post(app, body({ voice: 'hera' }));

    const started = logs.entries.find((entry) => entry.message === 'read_text_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: AURA_2!.id,
      characterCount: 12
    });
  });

  // Which control was set is the diagnostic. A request that failed with an unusual voice and one
  // that failed with the default fail for entirely different reasons.
  it('names the controls the caller set, with their values', async () => {
    const { app, logs } = mount();
    await post(app, body({ voice: 'orion', format: 'wav' }));

    const started = logs.entries.find((entry) => entry.message === 'read_text_run_started');
    expect(started?.context?.['requestedControls']).toEqual(['voice', 'format']);
    expect(started?.context?.['requested']).toMatchObject({ voice: 'orion', format: 'wav' });
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'read_text_run_started')).toBe(true);
    expect(logs.entries.some((entry) => entry.message === 'read_text_run_failed')).toBe(true);
  });

  // Two requests that look identical in an access log have to be distinguishable in the structured
  // logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) => entry.message.startsWith('read_text_run'));
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  it('records the output shape on success, so a changed envelope is visible', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const completed = logs.entries.find((entry) => entry.message === 'read_text_run_completed');
    expect(completed?.context).toMatchObject({ mediaType: 'audio/mpeg' });
    expect(completed?.context?.['byteLength']).toBeGreaterThan(0);
  });

  it('records the character count on failure, so the attempt is reproducible', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    const failed = logs.entries.find((entry) => entry.message === 'read_text_run_failed');
    expect(failed?.context).toMatchObject({ characterCount: 12, model: AURA_2!.id });
  });

  // Written as "must not contain", because that is the direction that silently rots: a field added
  // later would pass a positive assertion while breaking this one.
  it('never logs the spoken text or the verified email', async () => {
    const { app, logs } = mount();
    await post(app, body({ text: 'a confidential passage' }));

    expect(logs.text()).not.toContain('confidential passage');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  it('never logs the generated audio', async () => {
    const { app, logs } = mount();
    const payload = (await (await post(app, body())).json()) as ReadTextResponse;

    expect(logs.text()).not.toContain(payload.speech.base64);
  });
});

describe('identity', () => {
  // The attribution rule, asserted where it would actually be broken. A body field cannot reach the
  // gateway, because the domain refuses the body outright and the actor is assembled from the
  // verified claims alone.
  it('attributes the run to the verified identity rather than anything in the body', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(inference.requests[0]?.actor).toEqual(IDENTITY);
  });
});
