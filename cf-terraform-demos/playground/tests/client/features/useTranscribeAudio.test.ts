import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useTranscribeAudio } from '../../../src/client/features/transcribe-audio/useTranscribeAudio';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import type { TranscribeAudioResponse } from '../../../src/shared/transcribe-audio';

/**
 * A base64 model with a large ceiling and a context prompt, matching Whisper large v3 turbo.
 */
const TURBO: CatalogueModel = {
  id: '@cf/test/turbo',
  name: 'Test Turbo',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/turbo',
  transcriptionControls: {
    audioEncoding: 'base64',
    maxAudioBytes: 4 * 1_024 * 1_024,
    languages: ['en', 'fr'],
    supportsContextPrompt: true,
    timestampGranularity: 'segment',
    confidenceScale: 'log-probability',
    pricePerAudioMinuteUsd: 0.000_5
  }
};

/**
 * A model with diarization, detection, punctuation, and BCP-47 codes, matching Nova 3.
 */
const NOVA: CatalogueModel = {
  id: '@cf/test/nova',
  name: 'Test Nova',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/nova',
  transcriptionControls: {
    audioEncoding: 'body-object',
    maxAudioBytes: 4 * 1_024 * 1_024,
    languages: ['en', 'en-GB'],
    supportsLanguageDetection: true,
    supportsDiarization: true,
    supportsPunctuation: true,
    timestampGranularity: 'word',
    confidenceScale: 'probability',
    pricePerAudioMinuteUsd: 0.005_2
  }
};

/**
 * A byte-array model with a much smaller ceiling and no controls at all, matching the original
 * Whisper. The small ceiling is the point: it is what makes a loaded file able to become invalid by
 * switching model.
 */
const SMALL: CatalogueModel = {
  id: '@cf/test/small',
  name: 'Test Small',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/small',
  transcriptionControls: {
    audioEncoding: 'byte-array',
    maxAudioBytes: 4_096,
    timestampGranularity: 'word',
    pricePerAudioMinuteUsd: 0.000_5
  }
};

/**
 * Builds a `File` of a given size that reports an audio type.
 *
 * @param size How many bytes it should hold.
 * @param name File name to report.
 * @returns The file.
 */
function audioFile(size = 2_048, name = 'clip.mp3'): File {
  return new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });
}

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<TranscribeAudioResponse> = {}): TranscribeAudioResponse {
  return {
    transcript: {
      text: 'Hello there',
      spans: [{ text: 'Hello there', startSeconds: 0, endSeconds: 1.2 }],
      timestampGranularity: 'segment',
      wordCount: 2,
      diarized: false
    },
    audio: { mediaType: 'audio/mpeg', byteLength: 2_048 },
    receipt: {
      runId: 'run-1',
      task: 'transcribe-audio',
      model: TURBO.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 900,
      startedAt: new Date().toISOString()
    },
    applied: { model: TURBO.id },
    ...overrides
  };
}

/**
 * Builds the composable with an injected transport.
 *
 * @param models Catalogue models to offer.
 * @param transport Transport to use.
 * @returns The composable result, with the transport exposed under its own name.
 */
function build(
  models: CatalogueModel[] = [TURBO, NOVA, SMALL],
  transport = vi.fn().mockResolvedValue(response())
) {
  const result = useTranscribeAudio({
    models: ref(models),
    transcribe: transport,
    // Resolve polls immediately rather than waiting seconds of real time.
    runOptions: { sleep: async () => undefined },
    now: () => 1_700_000_000_000
  });

  // Exposed as `transport` rather than merged over the composable's own `run` action, which it
  // would otherwise shadow — leaving every test calling the mock directly instead of the code
  // under test, and passing for the wrong reason.
  return { ...result, transport };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
});

describe('selecting a model', () => {
  it('defaults to the first reviewed model once the catalogue arrives', () => {
    expect(build().model.value).toBe(TURBO.id);
  });

  it('exposes the selected model descriptor', () => {
    expect(build().selectedModel.value?.name).toBe('Test Turbo');
  });

  // The per-model limit, surfaced for the picker. No earlier panel needed this: every other upload
  // ceiling in the demo is a panel-wide constant.
  it('reports the selected model\u2019s own size ceiling', async () => {
    const panel = build();
    expect(panel.maxAudioBytes.value).toBe(4 * 1_024 * 1_024);

    panel.model.value = SMALL.id;
    await nextTick();

    expect(panel.maxAudioBytes.value).toBe(4_096);
  });

  // Refusing rather than accepting is the safer direction when the limit is not yet known.
  it('reports a zero ceiling before the catalogue loads', () => {
    expect(build([]).maxAudioBytes.value).toBe(0);
  });
});

describe('resetting controls when the model changes', () => {
  it('clears a language the new model does not publish', async () => {
    const panel = build();
    panel.model.value = NOVA.id;
    await nextTick();
    panel.language.value = 'en-GB';

    panel.model.value = TURBO.id;
    await nextTick();

    expect(panel.language.value).toBeUndefined();
  });

  it('keeps a language the new model also publishes', async () => {
    const panel = build();
    panel.language.value = 'en';

    panel.model.value = NOVA.id;
    await nextTick();

    expect(panel.language.value).toBe('en');
  });

  it('clears every flag the new model does not support', async () => {
    const panel = build();
    panel.model.value = NOVA.id;
    await nextTick();
    panel.diarize.value = true;
    panel.punctuate.value = true;
    panel.detectLanguage.value = true;

    panel.model.value = TURBO.id;
    await nextTick();

    expect(panel.diarize.value).toBe(false);
    expect(panel.punctuate.value).toBe(false);
    expect(panel.detectLanguage.value).toBe(false);
  });

  it('clears a context prompt the new model does not accept', async () => {
    const panel = build();
    panel.contextPrompt.value = 'Cloudflare, Hono';

    panel.model.value = NOVA.id;
    await nextTick();

    expect(panel.contextPrompt.value).toBe('');
  });
});

describe('a loaded file against a changing size limit', () => {
  // The behaviour that makes this panel different. The same file is valid for one model and not
  // for another, and the visitor has to be told rather than discovering it at the server.
  it('reports when a loaded file is too large for a newly selected model', async () => {
    const panel = build();
    await panel.selectFile(audioFile(100_000));
    expect(panel.notice.value).toBeNull();

    panel.model.value = SMALL.id;
    await nextTick();

    expect(panel.notice.value).toMatch(/accepts smaller files/u);
    expect(panel.canTranscribe.value).toBe(false);
  });

  // Keeping the bytes is what lets switching back restore a working state. Discarding a large
  // upload the visitor waited to read would be a worse answer than telling them to pick a model.
  it('keeps the file so switching back restores a working state', async () => {
    const panel = build();
    await panel.selectFile(audioFile(100_000));

    panel.model.value = SMALL.id;
    await nextTick();
    expect(panel.audio.value).toBeDefined();

    panel.model.value = TURBO.id;
    await nextTick();

    expect(panel.notice.value).toBeNull();
    expect(panel.canTranscribe.value).toBe(true);
  });

  it('refuses a file larger than the selected model accepts', async () => {
    const panel = build();
    panel.model.value = SMALL.id;
    await nextTick();

    await panel.selectFile(audioFile(100_000));

    expect(panel.audio.value).toBeUndefined();
    expect(panel.error.value).toMatch(/larger than/u);
  });

  it('refuses a file too short to contain speech', async () => {
    const panel = build();
    await panel.selectFile(audioFile(16));

    expect(panel.audio.value).toBeUndefined();
    expect(panel.error.value).toMatch(/too short/u);
  });

  it('refuses a file that is not audio', async () => {
    const panel = build();
    await panel.selectFile(
      new File([new Uint8Array(2_048)], 'doc.pdf', { type: 'application/pdf' })
    );

    expect(panel.audio.value).toBeUndefined();
    expect(panel.error.value).toMatch(/not audio/u);
  });
});

describe('whether the panel can be submitted', () => {
  it('refuses before any audio is loaded', () => {
    expect(build().canTranscribe.value).toBe(false);
  });

  it('accepts once audio is loaded', async () => {
    const panel = build();
    await panel.selectFile(audioFile());

    expect(panel.canTranscribe.value).toBe(true);
  });

  it('refuses while a run is in flight', async () => {
    const panel = build();
    await panel.selectFile(audioFile());

    const running = panel.run();
    expect(panel.canTranscribe.value).toBe(false);
    await running;
  });

  it('refuses an over-long context prompt', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    panel.contextPrompt.value = 'a'.repeat(1_000);

    expect(panel.canTranscribe.value).toBe(false);
  });
});

describe('building the request', () => {
  it('sends the audio and the selected model', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ model: TURBO.id, runId: 'run-1' }),
      expect.anything()
    );
  });

  // Sending a `false` the visitor never touched would be a request they did not make, and for
  // detection it would actively conflict with a language hint.
  it('omits a flag the visitor did not set', async () => {
    const panel = build();
    panel.model.value = NOVA.id;
    await nextTick();
    await panel.selectFile(audioFile());
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('diarize');
    expect(sent).not.toHaveProperty('detectLanguage');
  });

  it('sends the flags the visitor set', async () => {
    const panel = build();
    panel.model.value = NOVA.id;
    await nextTick();
    panel.diarize.value = true;
    panel.punctuate.value = true;
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ diarize: true, punctuate: true }),
      expect.anything()
    );
  });

  // The server would refuse a control the model does not declare, so the browser does not offer
  // the chance to send one. This is the assertion that would catch a stale value surviving a model
  // switch and being forwarded.
  it('never sends a control the selected model does not declare', async () => {
    const panel = build();
    // Set directly, as a stale value surviving a reset would be.
    panel.diarize.value = true;
    panel.language.value = 'en-GB';
    await panel.selectFile(audioFile());
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('diarize');
    expect(sent).not.toHaveProperty('language');
  });

  it('omits a blank context prompt', async () => {
    const panel = build();
    panel.contextPrompt.value = '   ';
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transport.mock.calls[0]?.[0]).not.toHaveProperty('contextPrompt');
  });

  it('trims a context prompt before sending it', async () => {
    const panel = build();
    panel.contextPrompt.value = '  Hono, Kysely  ';
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ contextPrompt: 'Hono, Kysely' }),
      expect.anything()
    );
  });

  // No identity field, and no way to supply one: the actor comes from the verified Access JWT.
  it('never sends an identity field', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });

  // The server determines these from the bytes and refuses a body that claims them.
  it('never describes the audio itself', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['mediaType', 'contentType', 'fileName', 'durationSeconds']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });
});

describe('a successful run', () => {
  it('exposes the transcript, verified audio, receipt, and applied controls', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transcript.value?.text).toBe('Hello there');
    expect(panel.verifiedAudio.value?.mediaType).toBe('audio/mpeg');
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.model).toBe(TURBO.id);
  });

  it('clears the busy flag when the run finishes', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.transcribing.value).toBe(false);
  });

  it('estimates the cost once the server reported a duration', async () => {
    const panel = build(
      [TURBO],
      vi
        .fn()
        .mockResolvedValue(
          response({ audio: { mediaType: 'audio/wav', byteLength: 2_048, durationSeconds: 60 } })
        )
    );
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.estimatedCostUsd.value).toBeCloseTo(0.000_5, 6);
  });

  // The common case: a compressed file has no readable duration, so there is no estimate rather
  // than a zero.
  it('has no estimate when the server reported no duration', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.estimatedCostUsd.value).toBeUndefined();
  });

  // A transcript left on screen beside a different recording reads as a transcript *of* the new
  // recording.
  it('discards the previous transcript when new audio is loaded', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();
    expect(panel.transcript.value).toBeDefined();

    await panel.selectFile(audioFile(4_096, 'other.mp3'));

    expect(panel.transcript.value).toBeUndefined();
    expect(panel.receipt.value).toBeUndefined();
  });

  it('discards the transcript when the audio is removed', async () => {
    const panel = build();
    await panel.selectFile(audioFile());
    await panel.run();

    panel.clearAudio();

    expect(panel.audio.value).toBeUndefined();
    expect(panel.transcript.value).toBeUndefined();
  });
});

describe('failures', () => {
  it('shows the server\u2019s own message for an API failure', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'Test Turbo does not support that.'));
    const panel = build([TURBO], transport);
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.error.value).toBe('Test Turbo does not support that.');
  });

  it('falls back to a generic message for a transport failure', async () => {
    const panel = build([TURBO], vi.fn().mockRejectedValue(new Error('offline')));
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.error.value).toMatch(/could not be transcribed/u);
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message. Showing
  // one would make a deliberate action look broken.
  it('reports no error when the visitor cancels', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const panel = build([TURBO], vi.fn().mockRejectedValue(abort));
    await panel.selectFile(audioFile());
    await panel.run();

    expect(panel.error.value).toBeNull();
  });

  it('aborts the request when cancelled', async () => {
    const panel = build();
    await panel.selectFile(audioFile());

    const running = panel.run();
    panel.cancel();
    await running;

    const signal = panel.transport.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('clears a previous error on the next attempt', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'Provider failed.'))
      .mockResolvedValueOnce(response());
    const panel = build([TURBO], transport);
    await panel.selectFile(audioFile());

    await panel.run();
    expect(panel.error.value).toBe('Provider failed.');

    await panel.run();
    expect(panel.error.value).toBeNull();
  });
});

describe('the microphone flow', () => {
  // The panel must work without it. A browser lacking the APIs loses the record button and
  // nothing else, which is why the upload path is never gated on this.
  it('reports the feature as unsupported when the browser lacks the APIs', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(build().recordingState.value).toBe('unsupported');
  });

  it('does nothing when asked to record on an unsupported browser', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const panel = build();

    await panel.startRecording();

    expect(panel.recordingState.value).toBe('unsupported');
  });
});
