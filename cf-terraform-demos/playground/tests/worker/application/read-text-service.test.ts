import { beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_SPEECH_BYTES } from '../../../src/shared/read-text';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { ReadTextService } from '../../../src/worker/application/read-text/read-text-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { validateReadTextRequest } from '../../../src/worker/domain/read-text';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  mp3FrameBytes,
  mp3WithId3Bytes,
  rawPcmBytes,
  streamOf,
  wavBytes
} from '../support/audio-fixtures';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

/**
 * The reviewed speech models, in catalogue order.
 */
const [AURA_2, , MELO] = modelsForTask('read-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity runs are attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Builds the service with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to a streamed MP3, which is what both
 *   Aura models return.
 * @returns The service, the fake port, and the captured logs.
 */
function build(options: FakeInferenceOptions = {}): {
  service: ReadTextService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({
    output: () => streamOf(mp3WithId3Bytes()),
    ...options
  });
  const { capture, logger } = createLogCapture();
  // One clock for both. The repository prunes records past its retention window, so a service
  // writing at an injected fixed time into a repository reading the real clock would have its
  // record expire the instant it was saved.
  const now = (): number => 1_000;
  const runs = createMemoryRunRepository(now);

  return {
    service: new ReadTextService({ inference, runs, logger, now }),
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
  return validateReadTextRequest({
    text: 'Hello there.',
    model: AURA_2!.id,
    runId: RUN_ID,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('generating speech', () => {
  it('returns verified audio, a receipt, and the applied controls', async () => {
    const { service } = build();
    const result = await service.generate(request(), ACTOR);

    expect(result.speech.mediaType).toBe('audio/mpeg');
    expect(result.speech.byteLength).toBeGreaterThan(0);
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'read-text',
      model: AURA_2!.id,
      gatewayRouted: true,
      status: 'completed'
    });
    expect(result.applied.voice).toBe('luna');
  });

  it('routes the call through the gateway with the panel\u2019s task identifier', async () => {
    const { service, inference } = build();
    await service.generate(request(), ACTOR);

    expect(inference.requests[0]).toMatchObject({ task: 'read-text', model: AURA_2 });
  });

  // The attribution rule, asserted at the boundary that reaches the gateway. A run that could be
  // made without an identity would be a run producing an unattributable charge.
  it('attributes the run to the verified actor', async () => {
    const { service, inference } = build();
    await service.generate(request(), ACTOR);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  // Written before the method returns, so there is no window in which the browser holds a receipt
  // the server cannot resolve.
  it('persists the run record before returning', async () => {
    const { service, runs } = build();
    await service.generate(request(), ACTOR);

    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'read-text',
      ownerEmail: ACTOR.email,
      status: 'completed'
    });
  });

  it('marks the cost pending when the gateway assigned a log', async () => {
    const { service } = build({ logId: 'log-9' });
    const result = await service.generate(request(), ACTOR);

    expect(result.receipt.logIds).toEqual(['log-9']);
    expect(result.receipt.costStatus).toBe('pending');
  });

  // A run with no log will never resolve a cost, so it must not be reported as pending — the panel
  // would poll the full budget to learn what the receipt already knew.
  it('does not mark the cost pending when no log was assigned', async () => {
    const { service } = build({ logId: null });
    const result = await service.generate(request(), ACTOR);

    expect(result.receipt.logIds).toEqual([]);
    expect(result.receipt.costStatus).not.toBe('pending');
  });
});

describe('normalising provider output', () => {
  // Both Aura models return a stream, and the read is chunked, so a multi-chunk stream is the real
  // production path rather than a contrived one.
  it('accepts a streamed MP3 delivered in several chunks', async () => {
    const { service } = build({ output: () => streamOf(mp3WithId3Bytes(256), 8) });
    const result = await service.generate(request(), ACTOR);

    expect(result.speech.mediaType).toBe('audio/mpeg');
  });

  it('accepts an MP3 that begins with a frame header rather than a tag', async () => {
    const { service } = build({ output: () => streamOf(mp3FrameBytes()) });
    expect((await service.generate(request(), ACTOR)).speech.mediaType).toBe('audio/mpeg');
  });

  // MeloTTS's output schema declares two shapes without saying which to expect, so both have to
  // work. A service that handled only the stream would fail intermittently against one model.
  it('accepts the base64 JSON envelope MeloTTS may return', async () => {
    const audio = Buffer.from(mp3WithId3Bytes()).toString('base64');
    const { service } = build({ output: () => ({ audio }) });

    const result = await service.generate(request({ model: MELO!.id }), ACTOR);
    expect(result.speech.mediaType).toBe('audio/mpeg');
  });

  it('accepts a raw byte array from the binding', async () => {
    const { service } = build({ output: () => mp3WithId3Bytes() });
    expect((await service.generate(request(), ACTOR)).speech.mediaType).toBe('audio/mpeg');
  });

  it('accepts an ArrayBuffer from the binding', async () => {
    const bytes = mp3WithId3Bytes();
    const { service } = build({ output: () => bytes.buffer.slice(0) });
    expect((await service.generate(request(), ACTOR)).speech.mediaType).toBe('audio/mpeg');
  });

  it('reports a WAV duration read from the container', async () => {
    const { service } = build({ output: () => streamOf(wavBytes(2), 4_096) });
    const result = await service.generate(request({ format: 'wav' }), ACTOR);

    expect(result.speech.mediaType).toBe('audio/wav');
    expect(result.durationSeconds).toBeCloseTo(2, 1);
  });

  // Absent rather than guessed. An MP3's duration needs a constant-bitrate assumption that is wrong
  // for real encoder output, and the panel reads the true value from the audio element instead.
  it('omits the duration for an MP3', async () => {
    const { service } = build();
    const result = await service.generate(request(), ACTOR);

    expect(result.durationSeconds).toBeUndefined();
  });

  it('rejects an empty response', async () => {
    const { service } = build({ output: () => streamOf(new Uint8Array(0)) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('rejects an unrecognised output shape', async () => {
    const { service } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('rejects a null output', async () => {
    const { service } = build({ output: () => null });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // The refusal this normalisation exists for. Aura's schema permits headerless PCM, which is real
  // audio data no browser will play; accepting it would put a silent broken player on the page.
  it('rejects raw headerless PCM', async () => {
    const { service } = build({ output: () => streamOf(rawPcmBytes()) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow(/will not play as audio/u);
  });

  it('rejects a JSON error document returned under a success status', async () => {
    const document = new TextEncoder().encode('{"error":"capacity"}');
    const { service } = build({ output: () => streamOf(document) });

    await expect(service.generate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // Enforced during the read rather than after it, so a misbehaving upstream cannot exhaust the
  // isolate's memory before the check runs.
  it('refuses audio beyond the size cap while reading it', async () => {
    const oversized = new Uint8Array(MAX_SPEECH_BYTES + 1_024);
    oversized.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);
    const { service } = build({ output: () => streamOf(oversized, 64 * 1_024) });

    await expect(service.generate(request(), ACTOR)).rejects.toThrow(/larger than this demo/u);
  });

  // A refusal here and a provider error both surface as a `502`, so the two are indistinguishable
  // from the browser — and they have completely different fixes. The log is what separates them.
  it('records why an output was refused, with the signature but not the payload', async () => {
    const { service, logs } = build({ output: () => streamOf(rawPcmBytes()) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find((entry) => entry.message === 'read_text_output_unusable');
    expect(refused?.context).toMatchObject({ reason: 'unplayable_format' });
    expect(refused?.context?.['signature']).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2})+$/u);
  });

  it('records an unrecognised envelope by its keys', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find((entry) => entry.message === 'read_text_output_unusable');
    expect(refused?.context).toMatchObject({
      reason: 'unrecognised_shape',
      outputKeys: ['unexpected']
    });
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

    await expect(service.generate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('does not persist a run record for a failed call', async () => {
    const { service, runs } = build({ failWith: new Error('upstream failure') });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('privacy', () => {
  // The text is the visitor's content and must not reach a Worker log. The character count carries
  // the diagnostic value without carrying the content.
  it('never logs the spoken text', async () => {
    const { service, logs } = build({ output: () => streamOf(rawPcmBytes()) });
    await expect(
      service.generate(request({ text: 'my confidential passage' }), ACTOR)
    ).rejects.toThrow();

    expect(logs.text()).not.toContain('my confidential passage');
  });

  // The email belongs in AI Gateway metadata, which is a different retention domain with different
  // access control.
  it('never logs the verified email', async () => {
    const { service, logs } = build({ output: () => streamOf(rawPcmBytes()) });
    await expect(service.generate(request(), ACTOR)).rejects.toThrow();

    expect(logs.text()).not.toContain(ACTOR.email);
  });

  // Base64 audio in a log line would be both a privacy breach and unreadable.
  it('never logs the generated audio', async () => {
    const { service, logs } = build();
    const result = await service.generate(request(), ACTOR);

    expect(logs.text()).not.toContain(result.speech.base64);
  });
});
