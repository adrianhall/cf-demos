import { describe, expect, it } from 'vitest';
import {
  countTranscriptWords,
  estimateTranscriptionCostUsd,
  formatTimestamp,
  isAcceptedAudioMediaType,
  MAX_CONTEXT_PROMPT_CHARACTERS,
  MIN_INPUT_AUDIO_BYTES,
  TRANSCRIPTION_CONTROL_NAMES
} from '../../../src/shared/transcribe-audio';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  buildTranscribeAudioInput,
  describeAppliedTranscriptionControls,
  validateTranscribeAudioRequest
} from '../../../src/worker/domain/transcribe-audio';
import { mp3WithId3Bytes, wavBytes, webmBytes } from '../support/audio-fixtures';

/**
 * The reviewed transcription models, in catalogue order.
 */
const [TURBO, NOVA, WHISPER] = modelsForTask('transcribe-audio');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * Encodes bytes as base64 for a request body.
 *
 * @param bytes Data to encode.
 * @returns The base64 representation.
 */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * A small but acceptable MP3, used wherever the audio itself is not what is under test.
 */
const AUDIO = base64(mp3WithId3Bytes(2_048));

/**
 * Builds a request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { audioBase64: AUDIO, model: TURBO!.id, runId: RUN_ID, ...overrides };
}

describe('validating a request', () => {
  it('accepts a minimal request and resolves the model', () => {
    const request = validateTranscribeAudioRequest(body());

    expect(request.model.id).toBe(TURBO!.id);
    expect(request.runId).toBe(RUN_ID);
    expect(request.audioFacts.mediaType).toBe('audio/mpeg');
  });

  it('rejects a body that is not an object', () => {
    expect(() => validateTranscribeAudioRequest('nope')).toThrow();
    expect(() => validateTranscribeAudioRequest([])).toThrow();
    expect(() => validateTranscribeAudioRequest(null)).toThrow();
  });

  it('rejects a malformed run identifier', () => {
    expect(() => validateTranscribeAudioRequest(body({ runId: 'short' }))).toThrow();
    expect(() => validateTranscribeAudioRequest(body({ runId: 'has spaces' }))).toThrow();
  });

  it('rejects a model belonging to another panel', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: '@cf/deepgram/aura-2-en' }))
    ).toThrow();
  });

  it('rejects an unknown model', () => {
    expect(() => validateTranscribeAudioRequest(body({ model: '@cf/not/a-model' }))).toThrow();
  });

  // The attribution rule. The actor comes from the verified Access JWT alone, so a body carrying
  // one of these is refused rather than quietly corrected.
  it('rejects a body carrying an identity field', () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(
        () => validateTranscribeAudioRequest(body({ [field]: 'mallory@example.com' })),
        field
      ).toThrow();
    }
  });

  // Refused rather than ignored, and it matters more here than for images: Nova 3's schema
  // *requires* a content type, so this value becomes a real field of the outgoing request and must
  // come from the bytes rather than from the caller.
  it('rejects a body describing the audio itself', () => {
    for (const field of ['mediaType', 'contentType', 'mimeType', 'durationSeconds', 'fileName']) {
      expect(() => validateTranscribeAudioRequest(body({ [field]: 'audio/wav' })), field).toThrow();
    }
  });
});

describe('verifying the submitted audio', () => {
  it('identifies each accepted format from its bytes', () => {
    expect(validateTranscribeAudioRequest(body()).audioFacts.mediaType).toBe('audio/mpeg');
    expect(
      validateTranscribeAudioRequest(body({ audioBase64: base64(wavBytes(1)) })).audioFacts
        .mediaType
    ).toBe('audio/wav');
    // The format a browser's own recorder produces, so the microphone path depends on this.
    expect(
      validateTranscribeAudioRequest(body({ audioBase64: base64(webmBytes(2_048)) })).audioFacts
        .mediaType
    ).toBe('audio/webm');
  });

  it('rejects a file that is not audio', () => {
    const text = new TextEncoder().encode('x'.repeat(2_048));
    expect(() => validateTranscribeAudioRequest(body({ audioBase64: base64(text) }))).toThrow(
      /not audio this panel accepts/u
    );
  });

  it('rejects absent or empty audio', () => {
    expect(() => validateTranscribeAudioRequest(body({ audioBase64: undefined }))).toThrow();
    expect(() => validateTranscribeAudioRequest(body({ audioBase64: '' }))).toThrow();
  });

  it('rejects undecodable base64', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ audioBase64: 'not valid base64!!!' }))
    ).toThrow();
  });

  it('rejects a file too short to contain speech', () => {
    const tiny = base64(mp3WithId3Bytes(8));
    expect(() => validateTranscribeAudioRequest(body({ audioBase64: tiny }))).toThrow(/too short/u);
  });

  it('reads a WAV duration from its header', () => {
    const request = validateTranscribeAudioRequest(body({ audioBase64: base64(wavBytes(3)) }));

    expect(request.audioFacts.durationSeconds).toBeCloseTo(3, 1);
  });

  // Absent rather than guessed. The cost estimate is derived from the duration, so a guessed
  // duration would become a guessed price presented as an estimate.
  it('reports no duration for a compressed file', () => {
    expect(validateTranscribeAudioRequest(body()).audioFacts.durationSeconds).toBeUndefined();
  });

  it('rejects audio longer than the duration limit', () => {
    // 11 minutes at a low rate stays inside the byte cap while exceeding the duration cap, which
    // is precisely the case the duration check exists for.
    const long = base64(wavBytes(660, 1_000, 1, 8));
    expect(() => validateTranscribeAudioRequest(body({ audioBase64: long }))).toThrow(
      /minutes long/u
    );
  });
});

describe('the per-model size limit', () => {
  /**
   * Audio larger than the byte-array model's ceiling but inside the others'.
   */
  const large = base64(mp3WithId3Bytes(1_200 * 1_024));

  // The substance of this panel. The same file is legitimately accepted for one model and refused
  // for another, because the encoding a model demands decides what is safe to send.
  it('accepts a file for a base64 model that it refuses for the byte-array model', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: TURBO!.id, audioBase64: large }))
    ).not.toThrow();

    expect(() =>
      validateTranscribeAudioRequest(body({ model: WHISPER!.id, audioBase64: large }))
    ).toThrow();
  });

  // A bare "too large" would leave a visitor who just succeeded with the same file on another
  // model believing the panel was broken.
  it('names the model and explains why its limit is lower', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: WHISPER!.id, audioBase64: large }))
    ).toThrow(/Whisper \(original\)/u);

    expect(() =>
      validateTranscribeAudioRequest(body({ model: WHISPER!.id, audioBase64: large }))
    ).toThrow(/JSON array of byte values/u);
  });

  it('accepts the same file for the other large-file model', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: NOVA!.id, audioBase64: large }))
    ).not.toThrow();
  });

  it('enforces the floor consistently with the shared constant', () => {
    expect(MIN_INPUT_AUDIO_BYTES).toBeGreaterThan(0);
  });
});

describe('validating controls against the selected model', () => {
  it('accepts a language the model publishes', () => {
    expect(validateTranscribeAudioRequest(body({ language: 'fr' })).language).toBe('fr');
  });

  // The two models that take a language use different standards, so a code valid for one is
  // invalid for the other. Merging the lists would invent a standard no provider agreed to.
  it('accepts a BCP-47 tag only for the model that uses them', () => {
    expect(
      validateTranscribeAudioRequest(body({ model: NOVA!.id, language: 'en-GB' })).language
    ).toBe('en-GB');

    expect(() => validateTranscribeAudioRequest(body({ language: 'en-GB' }))).toThrow();
  });

  // Not merely out of range — the field does not exist in its schema at all.
  it('rejects a language on the model with no language parameter', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: WHISPER!.id, language: 'en' }))
    ).toThrow(/Whisper \(original\)/u);
  });

  it('rejects a language outside the published list', () => {
    expect(() => validateTranscribeAudioRequest(body({ language: 'xx' }))).toThrow();
  });

  it('compares a language code exactly, without normalising case', () => {
    expect(() => validateTranscribeAudioRequest(body({ language: 'EN' }))).toThrow();
  });

  it('accepts diarization only for the model that supports it', () => {
    expect(validateTranscribeAudioRequest(body({ model: NOVA!.id, diarize: true })).diarize).toBe(
      true
    );
    expect(() => validateTranscribeAudioRequest(body({ diarize: true }))).toThrow();
  });

  it('accepts punctuation only for the model that supports it', () => {
    expect(
      validateTranscribeAudioRequest(body({ model: NOVA!.id, punctuate: true })).punctuate
    ).toBe(true);
    expect(() => validateTranscribeAudioRequest(body({ punctuate: true }))).toThrow();
  });

  it('accepts a context prompt only for the model that supports it', () => {
    expect(
      validateTranscribeAudioRequest(body({ contextPrompt: 'Cloudflare, Hono' })).contextPrompt
    ).toBe('Cloudflare, Hono');

    expect(() =>
      validateTranscribeAudioRequest(body({ model: NOVA!.id, contextPrompt: 'x' }))
    ).toThrow();
  });

  it('rejects an over-long context prompt', () => {
    const long = 'a'.repeat(MAX_CONTEXT_PROMPT_CHARACTERS + 1);
    expect(() => validateTranscribeAudioRequest(body({ contextPrompt: long }))).toThrow();
  });

  // An empty prompt sent as an empty string would be a real instruction to bias towards nothing.
  it('treats a blank context prompt as absent', () => {
    expect(
      validateTranscribeAudioRequest(body({ contextPrompt: '   ' })).contextPrompt
    ).toBeUndefined();
  });

  it('rejects a non-boolean flag', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: NOVA!.id, diarize: 'yes' }))
    ).toThrow();
  });

  // Individually legal, contradictory together. The provider would silently honour one, and
  // picking a winner on the visitor's behalf would hide which took effect.
  it('rejects a language hint together with language detection', () => {
    expect(() =>
      validateTranscribeAudioRequest(
        body({ model: NOVA!.id, language: 'en', detectLanguage: true })
      )
    ).toThrow(/not both/u);
  });

  it('accepts either one on its own', () => {
    expect(() =>
      validateTranscribeAudioRequest(body({ model: NOVA!.id, detectLanguage: true }))
    ).not.toThrow();
    expect(() =>
      validateTranscribeAudioRequest(body({ model: NOVA!.id, language: 'en' }))
    ).not.toThrow();
  });

  // A guard on the control list: a control added to the contract without validation would pass
  // every other test in this file while being forwarded unchecked.
  it('validates or rejects every named control', () => {
    const values: Record<string, unknown> = {
      language: 'not-a-language',
      detectLanguage: 'not-a-boolean',
      diarize: 'not-a-boolean',
      punctuate: 'not-a-boolean',
      contextPrompt: 'a'.repeat(MAX_CONTEXT_PROMPT_CHARACTERS + 1)
    };

    for (const control of TRANSCRIPTION_CONTROL_NAMES) {
      expect(
        () => validateTranscribeAudioRequest(body({ model: NOVA!.id, [control]: values[control] })),
        control
      ).toThrow();
    }
  });
});

describe('building the model input', () => {
  // Three encodings of the same bytes. This is the assertion that would catch a model being sent
  // a shape its schema does not declare.
  it('encodes the audio the way each model\u2019s schema demands', () => {
    const turbo = buildTranscribeAudioInput(validateTranscribeAudioRequest(body()));
    expect(typeof turbo['audio']).toBe('string');

    const nova = buildTranscribeAudioInput(
      validateTranscribeAudioRequest(body({ model: NOVA!.id }))
    );
    expect(nova['audio']).toMatchObject({ contentType: 'audio/mpeg' });
    expect(typeof (nova['audio'] as Record<string, unknown>)['body']).toBe('string');

    const whisper = buildTranscribeAudioInput(
      validateTranscribeAudioRequest(body({ model: WHISPER!.id }))
    );
    expect(Array.isArray(whisper['audio'])).toBe(true);
  });

  // The content type is the sniffed one, which is why self-described fields are refused rather
  // than ignored: this value is a required field of Nova 3's request.
  it('sends the sniffed content type, not one the caller chose', () => {
    const input = buildTranscribeAudioInput(
      validateTranscribeAudioRequest(body({ model: NOVA!.id, audioBase64: base64(wavBytes(1)) }))
    );

    expect(input['audio']).toMatchObject({ contentType: 'audio/wav' });
  });

  it('expands the byte array to one number per byte', () => {
    const bytes = mp3WithId3Bytes(2_048);
    const input = buildTranscribeAudioInput(
      validateTranscribeAudioRequest(body({ model: WHISPER!.id, audioBase64: base64(bytes) }))
    );

    expect((input['audio'] as number[]).length).toBe(bytes.length);
  });

  it('sends a chosen language under the provider\u2019s own key', () => {
    expect(
      buildTranscribeAudioInput(validateTranscribeAudioRequest(body({ language: 'fr' })))
    ).toMatchObject({ language: 'fr' });
  });

  it('sends the flags under their provider keys', () => {
    const input = buildTranscribeAudioInput(
      validateTranscribeAudioRequest(body({ model: NOVA!.id, diarize: true, punctuate: true }))
    );

    expect(input).toMatchObject({ diarize: true, punctuate: true });
  });

  it('sends a context prompt as initial_prompt', () => {
    expect(
      buildTranscribeAudioInput(
        validateTranscribeAudioRequest(body({ contextPrompt: 'Hono, Kysely' }))
      )
    ).toMatchObject({ initial_prompt: 'Hono, Kysely' });
  });

  // Nothing a model did not declare reaches the provider.
  it('sends only the audio when no controls were chosen', () => {
    expect(Object.keys(buildTranscribeAudioInput(validateTranscribeAudioRequest(body())))).toEqual([
      'audio'
    ]);
  });

  it('never forwards the run identifier or the model name', () => {
    const input = buildTranscribeAudioInput(validateTranscribeAudioRequest(body()));

    expect(input).not.toHaveProperty('runId');
    expect(input).not.toHaveProperty('model');
  });
});

describe('describing the applied controls', () => {
  it('reports the model and the chosen controls', () => {
    const applied = describeAppliedTranscriptionControls(
      validateTranscribeAudioRequest(body({ language: 'de' }))
    );

    expect(applied).toMatchObject({ model: TURBO!.id, language: 'de' });
  });

  it('omits a control the caller did not choose', () => {
    const applied = describeAppliedTranscriptionControls(validateTranscribeAudioRequest(body()));

    expect(applied.language).toBeUndefined();
    expect(applied.diarize).toBeUndefined();
  });

  // A flag rather than the text. The browser already has the prompt, and returning it would put
  // the visitor's content in one more place for no benefit.
  it('reports that a context prompt was used without echoing it', () => {
    const applied = describeAppliedTranscriptionControls(
      validateTranscribeAudioRequest(body({ contextPrompt: 'something private' }))
    );

    expect(applied.contextPromptUsed).toBe(true);
    expect(JSON.stringify(applied)).not.toContain('something private');
  });

  it('estimates the cost when the duration is known', () => {
    const applied = describeAppliedTranscriptionControls(
      validateTranscribeAudioRequest(body({ audioBase64: base64(wavBytes(60)) }))
    );

    expect(applied.estimatedCostUsd).toBeCloseTo(0.000_5, 6);
  });

  it('estimates more for the more expensive model', () => {
    const applied = describeAppliedTranscriptionControls(
      validateTranscribeAudioRequest(body({ model: NOVA!.id, audioBase64: base64(wavBytes(60)) }))
    );

    expect(applied.estimatedCostUsd).toBeCloseTo(0.005_2, 6);
  });

  // Absent rather than zero. A zero would read as "free", which is the one thing a cost figure
  // must never do.
  it('omits the estimate when the duration is unknown', () => {
    const applied = describeAppliedTranscriptionControls(validateTranscribeAudioRequest(body()));

    expect(applied.estimatedCostUsd).toBeUndefined();
    expect(applied).not.toHaveProperty('estimatedCostUsd');
  });
});

describe('the shared helpers', () => {
  it('scales the cost estimate with duration', () => {
    expect(estimateTranscriptionCostUsd(120, 0.006)).toBeCloseTo(0.012, 6);
    expect(estimateTranscriptionCostUsd(30, 0.006)).toBeCloseTo(0.003, 6);
  });

  it('has no estimate without a duration', () => {
    expect(estimateTranscriptionCostUsd(undefined, 0.006)).toBeUndefined();
  });

  it('counts words consistently', () => {
    expect(countTranscriptWords('one two three')).toBe(3);
    expect(countTranscriptWords('  spaced   out  ')).toBe(2);
    expect(countTranscriptWords('')).toBe(0);
    expect(countTranscriptWords('   ')).toBe(0);
  });

  it('formats timestamps as minutes and seconds', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(7)).toBe('0:07');
    expect(formatTimestamp(65)).toBe('1:05');
  });

  it('includes hours past an hour', () => {
    expect(formatTimestamp(3_723)).toBe('1:02:03');
  });

  // Guards against a provider returning something that is not an offset, which would otherwise
  // render as `NaN:NaN`.
  it('renders a non-finite or negative offset as zero', () => {
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
    expect(formatTimestamp(-5)).toBe('0:00');
  });

  it('accepts exactly the input formats the panel allows', () => {
    expect(isAcceptedAudioMediaType('audio/webm')).toBe(true);
    expect(isAcceptedAudioMediaType('audio/mp4')).toBe(true);
    expect(isAcceptedAudioMediaType('audio/flac')).toBe(false);
    expect(isAcceptedAudioMediaType('video/mp4')).toBe(false);
  });
});
