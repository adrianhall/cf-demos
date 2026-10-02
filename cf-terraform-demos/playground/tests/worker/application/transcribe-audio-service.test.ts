import { beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { TranscribeAudioService } from '../../../src/worker/application/transcribe-audio/transcribe-audio-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { validateTranscribeAudioRequest } from '../../../src/worker/domain/transcribe-audio';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { mp3WithId3Bytes, wavBytes } from '../support/audio-fixtures';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

/**
 * The reviewed transcription models, in catalogue order.
 */
const [TURBO, NOVA, WHISPER] = modelsForTask('transcribe-audio');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity runs are attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

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
 * Builds the service with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to a well-formed turbo response.
 * @returns The service, the fake port, the run repository, and the captured logs.
 */
function build(options: FakeInferenceOptions = {}): {
  service: TranscribeAudioService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({ output: () => TURBO_OUTPUT, ...options });
  const { capture, logger } = createLogCapture();
  // One clock for both. The repository prunes records past its retention window, so a service
  // writing at an injected fixed time into a repository reading the real clock would have its
  // record expire the instant it was saved.
  const now = (): number => 1_000;
  const runs = createMemoryRunRepository(now);

  return {
    service: new TranscribeAudioService({ inference, runs, logger, now }),
    inference,
    runs,
    logs: capture
  };
}

/**
 * Validates a request body, so the service receives the type it requires.
 *
 * @param overrides Fields to replace or add.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}) {
  return validateTranscribeAudioRequest({
    audioBase64: AUDIO,
    model: TURBO!.id,
    runId: RUN_ID,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('transcribing audio', () => {
  it('returns a transcript, verified audio facts, a receipt, and the applied controls', async () => {
    const { service } = build();
    const result = await service.transcribe(request(), ACTOR);

    expect(result.transcript.text).toBe('Hello there.');
    expect(result.audio.mediaType).toBe('audio/mpeg');
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'transcribe-audio',
      model: TURBO!.id,
      gatewayRouted: true,
      status: 'completed'
    });
    expect(result.applied.model).toBe(TURBO!.id);
  });

  it('routes the call through the gateway with the panel\u2019s task identifier', async () => {
    const { service, inference } = build();
    await service.transcribe(request(), ACTOR);

    expect(inference.requests[0]).toMatchObject({ task: 'transcribe-audio', model: TURBO });
  });

  // The attribution rule, asserted at the boundary that reaches the gateway. A run that could be
  // made without an identity would be a run producing an unattributable charge.
  it('attributes the run to the verified actor', async () => {
    const { service, inference } = build();
    await service.transcribe(request(), ACTOR);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  // Written before the method returns, so there is no window in which the browser holds a receipt
  // the server cannot resolve.
  it('persists the run record before returning', async () => {
    const { service, runs } = build();
    await service.transcribe(request(), ACTOR);

    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'transcribe-audio',
      ownerEmail: ACTOR.email,
      status: 'completed'
    });
  });

  it('marks the cost pending when the gateway assigned a log', async () => {
    const { service } = build({ logId: 'log-9' });
    const result = await service.transcribe(request(), ACTOR);

    expect(result.receipt.logIds).toEqual(['log-9']);
    expect(result.receipt.costStatus).toBe('pending');
  });

  // A run with no log will never resolve a cost, so it must not be reported as pending — the panel
  // would poll the full budget to learn what the receipt already knew.
  it('does not mark the cost pending when no log was assigned', async () => {
    const { service } = build({ logId: null });
    const result = await service.transcribe(request(), ACTOR);

    expect(result.receipt.logIds).toEqual([]);
    expect(result.receipt.costStatus).not.toBe('pending');
  });

  it('reports an estimate when the submitted audio declared a duration', async () => {
    const { service } = build();
    const wav = Buffer.from(wavBytes(60)).toString('base64');
    const result = await service.transcribe(request({ audioBase64: wav }), ACTOR);

    expect(result.audio.durationSeconds).toBeCloseTo(60, 0);
    expect(result.applied.estimatedCostUsd).toBeCloseTo(0.000_5, 6);
  });
});

describe('normalising each provider envelope end to end', () => {
  // The service picks the envelope from the descriptor, so each model needs its own response
  // shape exercised through the real service rather than only against the normaliser.
  it('reads the Nova envelope for the Nova descriptor', async () => {
    const { service } = build({
      output: () => ({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'Nova heard this',
                  words: [{ word: 'Nova', start: 0, end: 0.4, confidence: 0.97 }]
                }
              ]
            }
          ]
        }
      })
    });

    const result = await service.transcribe(request({ model: NOVA!.id }), ACTOR);

    expect(result.transcript.text).toBe('Nova heard this');
    expect(result.transcript.confidenceScale).toBe('probability');
  });

  it('reads the per-word envelope for the original Whisper descriptor', async () => {
    const { service } = build({
      output: () => ({ text: 'Whisper heard this', words: [{ word: 'Whisper', start: 0, end: 1 }] })
    });

    const result = await service.transcribe(request({ model: WHISPER!.id }), ACTOR);

    expect(result.transcript.timestampGranularity).toBe('word');
    expect(result.transcript.confidenceScale).toBeUndefined();
  });

  // A model returning another model's shape is a contract break, and it has to be loud rather
  // than silently producing an empty transcript.
  it('refuses a response in the wrong envelope', async () => {
    const { service } = build({
      output: () => ({ results: { channels: [{ alternatives: [{ transcript: 'wrong shape' }] }] } })
    });

    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });
});

describe('refusing unusable output', () => {
  it('rejects a non-object response', async () => {
    const { service } = build({ output: () => 'just a string' });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('rejects an unrecognised envelope', async () => {
    const { service } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // Very likely not a fault at all — silent audio, or speech too quiet to make out. Telling the
  // visitor to try a different model would send them to spend credit on the same outcome.
  it('explains an empty transcript as probably-silent audio', async () => {
    const { service } = build({ output: () => ({ text: '' }) });

    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(/silent|too quiet/u);
  });

  it('suggests another model for a broken envelope', async () => {
    const { service } = build({ output: () => ({ unexpected: 'envelope' }) });

    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(/different model/u);
  });

  // A refusal here and a provider error both surface as a `502`, so the two are indistinguishable
  // from the browser — and they have completely different fixes. The log is what separates them.
  it('records which envelope was expected and which keys arrived', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find(
      (entry) => entry.message === 'transcribe_audio_output_unusable'
    );
    expect(refused?.context).toMatchObject({
      reason: 'missing_transcript',
      expectedEnvelope: 'text',
      outputKeys: ['unexpected']
    });
  });

  it('records the nested envelope expectation for the Nova descriptor', async () => {
    const { service, logs } = build({ output: () => ({ text: 'wrong shape' }) });
    await expect(service.transcribe(request({ model: NOVA!.id }), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find(
      (entry) => entry.message === 'transcribe_audio_output_unusable'
    );
    expect(refused?.context?.['expectedEnvelope']).toBe('results.channels[].alternatives[]');
  });

  it('does not persist a run record for a refused output', async () => {
    const { service, runs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('provider failures', () => {
  // Thrown as the real inference client throws it: the client logs the provider's own message and
  // raises a sanitised problem-details error, so a fake throwing a bare `Error` would exercise a
  // path production never takes.
  it('propagates a sanitised provider failure', async () => {
    const { service } = build({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });

    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('does not persist a run record for a failed call', async () => {
    const { service, runs } = build({ failWith: new Error('upstream failure') });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('privacy', () => {
  // The transcript is the visitor's content and must not reach a Worker log, even on the failure
  // path where a developer might reasonably want to see it.
  it('never logs the transcript', async () => {
    const { service, logs } = build({
      output: () => ({ text: 'my confidential conversation', segments: 'broken' })
    });
    await service.transcribe(request(), ACTOR).catch(() => undefined);

    expect(logs.text()).not.toContain('my confidential conversation');
  });

  // Base64 audio in a log line would be both a privacy breach and unreadable.
  it('never logs the submitted audio', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow();

    expect(logs.text()).not.toContain(AUDIO.slice(0, 64));
  });

  // The email belongs in AI Gateway metadata, which is a different retention domain with
  // different access control.
  it('never logs the verified email', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.transcribe(request(), ACTOR)).rejects.toThrow();

    expect(logs.text()).not.toContain(ACTOR.email);
  });

  it('never logs a context prompt', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await service
      .transcribe(request({ contextPrompt: 'secret project codename' }), ACTOR)
      .catch(() => undefined);

    expect(logs.text()).not.toContain('secret project codename');
  });
});
