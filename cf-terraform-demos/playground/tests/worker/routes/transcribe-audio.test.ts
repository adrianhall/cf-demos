import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_INPUT_AUDIO_BYTES,
  type TranscribeAudioResponse
} from '../../../src/shared/transcribe-audio';
import { TranscribeAudioService } from '../../../src/worker/application/transcribe-audio/transcribe-audio-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES,
  transcribeAudioRouter
} from '../../../src/worker/routes/transcribe-audio';
import { mp3WithId3Bytes, wavBytes } from '../support/audio-fixtures';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed transcription models, in catalogue order.
 */
const [TURBO, NOVA, WHISPER] = modelsForTask('transcribe-audio');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * A small but acceptable MP3, base64-encoded.
 */
const AUDIO = Buffer.from(mp3WithId3Bytes(2_048)).toString('base64');

/**
 * A response in Whisper large v3 turbo's shape.
 */
const TURBO_OUTPUT = {
  text: 'Hello there.',
  transcription_info: { language: 'en' },
  segments: [{ start: 0, end: 1.2, text: 'Hello there.', avg_logprob: -0.2 }]
};

/**
 * A response in Nova 3's nested shape.
 *
 * Needed as a separate fixture because the service selects its envelope from the descriptor: a Nova
 * request answered with turbo's flat shape is a contract break and is correctly refused, so a test
 * checking Nova's _validation_ has to supply Nova's own envelope or it would be asserting on the
 * wrong failure.
 */
const NOVA_OUTPUT = {
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Hello there.',
            words: [{ word: 'Hello', start: 0, end: 0.5, confidence: 0.98 }]
          }
        ]
      }
    ]
  }
};

/**
 * Mounts the Transcribe Audio router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to a well-formed turbo response.
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
  const inference = new FakeInference({ output: () => TURBO_OUTPUT, ...options });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new TranscribeAudioService({
    inference,
    runs: createMemoryRunRepository(now),
    logger,
    now
  });

  const mounted = mountRoute('/api/transcribe-audio', transcribeAudioRouter, {
    identity,
    transcribeAudioService: service,
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
  return { audioBase64: AUDIO, model: TURBO!.id, runId: RUN_ID, ...overrides };
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
  return app.request('/api/transcribe-audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('transcribing a recording', () => {
  it('returns the transcript, verified audio facts, a receipt, and applied controls', async () => {
    const response = await post(mount().app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as TranscribeAudioResponse;
    expect(payload.transcript.text).toBe('Hello there.');
    expect(payload.audio.mediaType).toBe('audio/mpeg');
    expect(payload.receipt.runId).toBe(RUN_ID);
    expect(payload.applied.model).toBe(TURBO!.id);
  });

  it('reports the timed breakdown and the scale its numbers use', async () => {
    const payload = (await (await post(mount().app, body())).json()) as TranscribeAudioResponse;

    expect(payload.transcript.spans).toHaveLength(1);
    expect(payload.transcript.timestampGranularity).toBe('segment');
    expect(payload.transcript.confidenceScale).toBe('log-probability');
  });

  it('reports an estimate when the submitted audio declared a duration', async () => {
    // A low sample rate so two minutes of WAV stays inside the byte ceiling. Uncompressed audio at
    // the default 24 kHz would be 5.7 MB for this duration and be refused before it was measured,
    // which is itself the reason the panel caps bytes as well as seconds.
    const wav = Buffer.from(wavBytes(120, 8_000, 1, 8)).toString('base64');
    const payload = (await (
      await post(mount().app, body({ audioBase64: wav }))
    ).json()) as TranscribeAudioResponse;

    expect(payload.applied.estimatedCostUsd).toBeCloseTo(0.001, 5);
  });

  // Absent rather than zero: the duration of a compressed file is not knowable, and a zero would
  // read as free.
  it('omits the estimate when the duration is unknown', async () => {
    const payload = (await (await post(mount().app, body())).json()) as TranscribeAudioResponse;

    expect(payload.applied.estimatedCostUsd).toBeUndefined();
  });

  // Asserted at the route because this is the boundary a new control would be added at. Three
  // encodings of the same bytes, and only the one the model declared may be sent.
  it('encodes the audio the way the selected model demands', async () => {
    const { app, inference } = mount();
    await post(app, body({ model: NOVA!.id }));

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(input['audio']).toMatchObject({ contentType: 'audio/mpeg' });
  });

  it('expands the audio to a byte array for the model that demands one', async () => {
    const { app, inference } = mount({
      output: () => ({ text: 'ok', words: [{ word: 'ok', start: 0, end: 1 }] })
    });
    await post(app, body({ model: WHISPER!.id }));

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(Array.isArray(input['audio'])).toBe(true);
  });

  it('sends only the audio when no controls were chosen', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(Object.keys(inference.requests[0]?.input as Record<string, unknown>)).toEqual(['audio']);
  });
});

describe('rejected requests', () => {
  it('rejects a body carrying an identity field', async () => {
    expect((await post(mount().app, body({ email: 'mallory@example.com' }))).status).toBe(400);
  });

  it('rejects a body describing the audio itself', async () => {
    expect((await post(mount().app, body({ contentType: 'audio/wav' }))).status).toBe(400);
  });

  it('rejects a file that is not audio', async () => {
    const text = Buffer.from('x'.repeat(2_048)).toString('base64');
    expect((await post(mount().app, body({ audioBase64: text }))).status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    expect((await post(mount().app, body({ model: '@cf/deepgram/aura-2-en' }))).status).toBe(400);
  });

  // The per-model rule, at the HTTP boundary. The same file is accepted by one reviewed model and
  // refused by another, because the encoding each demands decides what is safe to send.
  it('accepts a file for one model that it refuses for another', async () => {
    const large = Buffer.from(mp3WithId3Bytes(1_200 * 1_024)).toString('base64');

    expect((await post(mount().app, body({ audioBase64: large }))).status).toBe(200);
    expect((await post(mount().app, body({ model: WHISPER!.id, audioBase64: large }))).status).toBe(
      400
    );
  });

  // The clearest demonstration that a language code is a per-model contract rather than a
  // universal identifier: the same BCP-47 tag is refused by one reviewed model and accepted by
  // the other, because they use different standards.
  it('rejects a language the selected model does not publish', async () => {
    expect((await post(mount().app, body({ language: 'en-GB' }))).status).toBe(400);

    const { app } = mount({ output: () => NOVA_OUTPUT });
    expect((await post(app, body({ model: NOVA!.id, language: 'en-GB' }))).status).toBe(200);
  });

  it('rejects a control the selected model does not support', async () => {
    expect((await post(mount().app, body({ diarize: true }))).status).toBe(400);
    expect((await post(mount().app, body({ punctuate: true }))).status).toBe(400);
  });

  it('rejects a context prompt on a model that takes none', async () => {
    expect((await post(mount().app, body({ model: NOVA!.id, contextPrompt: 'x' }))).status).toBe(
      400
    );
  });

  it('rejects a language hint together with language detection', async () => {
    const response = await post(
      mount().app,
      body({ model: NOVA!.id, language: 'en', detectLanguage: true })
    );
    expect(response.status).toBe(400);
  });

  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way.
  it('refuses a body beyond the transport limit', async () => {
    const { app } = mount();
    const response = await app.request('/api/transcribe-audio', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES + 1_024)
      },
      body: 'x'.repeat(TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES + 1_024)
    });

    expect(response.status).toBe(400);
  });

  // Derived from the audio ceiling rather than compared against a hard-coded size, so raising the
  // audio limit cannot silently leave the transport limit behind and turn a valid upload into an
  // opaque refusal. Base64 inflates by about a third.
  it('sizes the body limit to hold the largest accepted recording', () => {
    expect(TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_INPUT_AUDIO_BYTES * (4 / 3));
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

  // A third-party transcription model added later would make this reachable. The classification
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

    const started = logs.entries.find((entry) => entry.message === 'transcribe_audio_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: TURBO!.id,
      mediaType: 'audio/mpeg'
    });
  });

  // Which control was set is the diagnostic. A request that failed with an unusual language hint
  // and one that failed with none fail for entirely different reasons.
  it('names the controls the caller set, with their values', async () => {
    const { app, logs } = mount();
    await post(app, body({ model: NOVA!.id, language: 'fr', diarize: true }));

    const started = logs.entries.find((entry) => entry.message === 'transcribe_audio_run_started');
    expect(started?.context?.['requestedControls']).toEqual(['language', 'diarize']);
    expect(started?.context?.['requested']).toMatchObject({ language: 'fr', diarize: true });
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'transcribe_audio_run_started')).toBe(
      true
    );
    expect(logs.entries.some((entry) => entry.message === 'transcribe_audio_run_failed')).toBe(
      true
    );
  });

  // Two requests that look identical in an access log have to be distinguishable in the structured
  // logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) =>
      entry.message.startsWith('transcribe_audio_run')
    );
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  // A sudden absence of the timing or quality information a contract promises is the earliest
  // signal that an envelope changed, and it is invisible in a success status.
  it('records what the envelope actually produced on success', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const completed = logs.entries.find(
      (entry) => entry.message === 'transcribe_audio_run_completed'
    );
    expect(completed?.context).toMatchObject({
      wordCount: 2,
      spanCount: 1,
      timestampGranularity: 'segment',
      confidenceScale: 'log-probability',
      diarized: false
    });
  });

  it('records the audio facts on failure, so the attempt is reproducible', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    const failed = logs.entries.find((entry) => entry.message === 'transcribe_audio_run_failed');
    expect(failed?.context).toMatchObject({ mediaType: 'audio/mpeg', model: TURBO!.id });
  });

  // Written as "must not contain", because that is the direction that silently rots: a field added
  // later would pass a positive assertion while breaking this one.
  it('never logs the transcript, the audio, or the verified email', async () => {
    const { app, logs } = mount();
    const payload = (await (await post(app, body())).json()) as TranscribeAudioResponse;

    expect(logs.text()).not.toContain(payload.transcript.text);
    expect(logs.text()).not.toContain(AUDIO.slice(0, 64));
    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  // The one control that carries visitor-authored text, so it is recorded as a length rather than
  // a value.
  it('records a context prompt by length rather than content', async () => {
    const { app, logs } = mount();
    await post(app, body({ contextPrompt: 'secret codename' }));

    const started = logs.entries.find((entry) => entry.message === 'transcribe_audio_run_started');
    expect(started?.context?.['requested']).toMatchObject({ contextPromptCharacters: 15 });
    expect(logs.text()).not.toContain('secret codename');
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
