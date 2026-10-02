/**
 * @file Tests for the one piece of logic this panel genuinely turns on: reconciling three unrelated
 *   provider envelopes into a single transcript. Each reviewed model gets its real response shape
 *   here, taken from its published output schema, so a contract change shows up as a failing test
 *   rather than as a silently empty result in the browser.
 */

import { describe, expect, it } from 'vitest';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  MAX_TRANSCRIPT_SPANS,
  normaliseTranscript
} from '../../../src/worker/domain/transcript-normalisation';

/**
 * The reviewed transcription models, in catalogue order.
 */
const [TURBO, NOVA, WHISPER] = modelsForTask('transcribe-audio');

/**
 * A response in Whisper large v3 turbo's shape: flat `text` with `segments[]`.
 *
 * @param overrides Fields to replace.
 * @returns The provider output.
 */
function turboOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'Hello there. This is a test.',
    word_count: 6,
    transcription_info: { language: 'en', language_probability: 0.99, duration: 3.2 },
    segments: [
      { start: 0, end: 1.4, text: 'Hello there.', avg_logprob: -0.21 },
      { start: 1.4, end: 3.2, text: 'This is a test.', avg_logprob: -0.35 }
    ],
    ...overrides
  };
}

/**
 * A response in the original Whisper's shape: flat `text` with `words[]` and no language object.
 *
 * @param overrides Fields to replace.
 * @returns The provider output.
 */
function whisperOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'Hello there',
    word_count: 2,
    words: [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'there', start: 0.5, end: 0.9 }
    ],
    ...overrides
  };
}

/**
 * A response in Nova 3's shape: the transcript nested four levels deep.
 *
 * @param alternative Fields to replace on the chosen alternative.
 * @returns The provider output.
 */
function novaOutput(alternative: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    results: {
      channels: [
        {
          alternatives: [
            {
              confidence: 0.98,
              transcript: 'Hello there',
              words: [
                { word: 'Hello', start: 0, end: 0.5, confidence: 0.99 },
                { word: 'there', start: 0.5, end: 0.9, confidence: 0.94 }
              ],
              ...alternative
            }
          ]
        }
      ]
    }
  };
}

/**
 * Unwraps a successful outcome, failing the test when it was a refusal.
 *
 * @param outcome The normaliser's result.
 * @returns The transcript.
 */
function expectOk(outcome: ReturnType<typeof normaliseTranscript>) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error('expected a transcript');
  }
  return outcome.transcript;
}

describe('the reviewed transcription models', () => {
  it('registers three Cloudflare-hosted models', () => {
    const models = modelsForTask('transcribe-audio');
    expect(models).toHaveLength(3);
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
    }
  });

  // The reason phase 10 could follow phase 9 directly. A third-party model would reintroduce the
  // prepaid-credit prerequisite that blocks the deferred phases.
  it('needs no third-party model, so the panel needs no prepaid credit', () => {
    expect(
      modelsForTask('transcribe-audio').some((model) => model.provider === 'third-party')
    ).toBe(false);
  });

  it('defaults to a Cloudflare-hosted model', () => {
    expect(TURBO?.provider).toBe('workers-ai');
  });

  // The finding that shapes the whole panel: the same bytes, three different encodings.
  it('declares three different audio encodings', () => {
    expect(TURBO?.transcriptionControls?.audioEncoding).toBe('base64');
    expect(NOVA?.transcriptionControls?.audioEncoding).toBe('body-object');
    expect(WHISPER?.transcriptionControls?.audioEncoding).toBe('byte-array');
  });

  // The consequence a visitor notices. The byte-array model cannot safely be given as much as the
  // others, so its ceiling is lower — a property of its contract, not an arbitrary restriction.
  it('gives the byte-array model a smaller size ceiling than the others', () => {
    const byteArray = WHISPER?.transcriptionControls?.maxAudioBytes ?? 0;
    const base64 = TURBO?.transcriptionControls?.maxAudioBytes ?? 0;

    expect(byteArray).toBeLessThan(base64);
  });

  // Two different standards for the same conceptual control, which is why the lists are per model
  // rather than merged.
  it('declares language codes in each model\u2019s own standard', () => {
    expect(NOVA?.transcriptionControls?.languages).toContain('en-GB');
    expect(TURBO?.transcriptionControls?.languages).not.toContain('en-GB');
    // No language parameter whatsoever in its schema.
    expect(WHISPER?.transcriptionControls?.languages).toBeUndefined();
  });

  it('declares diarization only for the model that supports it', () => {
    expect(NOVA?.transcriptionControls?.supportsDiarization).toBe(true);
    expect(TURBO?.transcriptionControls?.supportsDiarization).toBeUndefined();
    expect(WHISPER?.transcriptionControls?.supportsDiarization).toBeUndefined();
  });

  // The disclosure this panel exists to make honestly. Rendering both as one bar would be a
  // fabrication, so the scales are distinct in the descriptor.
  it('distinguishes a probability from a log probability', () => {
    expect(NOVA?.transcriptionControls?.confidenceScale).toBe('probability');
    expect(TURBO?.transcriptionControls?.confidenceScale).toBe('log-probability');
    expect(WHISPER?.transcriptionControls?.confidenceScale).toBeUndefined();
  });

  // Every model must have a rate: the panel's whole comparison is cost per audio minute, and a
  // model with no published price could not be presented honestly beside one that has one. This is
  // why `@cf/openai/whisper-tiny-en` was not registered despite being in the plan.
  it('publishes a price per audio minute for every model', () => {
    for (const model of modelsForTask('transcribe-audio')) {
      expect(
        model.transcriptionControls?.pricePerAudioMinuteUsd,
        `${model.id} publishes a rate`
      ).toBeGreaterThan(0);
    }
  });

  it('shows a tenfold price difference across the reviewed models', () => {
    const cheap = TURBO?.transcriptionControls?.pricePerAudioMinuteUsd ?? 0;
    const dear = NOVA?.transcriptionControls?.pricePerAudioMinuteUsd ?? 0;

    expect(dear / cheap).toBeGreaterThan(5);
  });
});

describe('the Whisper large v3 turbo envelope', () => {
  it('reads the transcript and its segments', () => {
    const transcript = expectOk(normaliseTranscript(turboOutput(), TURBO!));

    expect(transcript.text).toBe('Hello there. This is a test.');
    expect(transcript.spans).toHaveLength(2);
    expect(transcript.spans[0]).toMatchObject({
      text: 'Hello there.',
      startSeconds: 0,
      endSeconds: 1.4
    });
  });

  it('reports phrase granularity', () => {
    expect(expectOk(normaliseTranscript(turboOutput(), TURBO!)).timestampGranularity).toBe(
      'segment'
    );
  });

  // Carried unchanged rather than rescaled. A negative number is the honest value, and mapping it
  // into [0, 1] would invent a meaning the model never gave it.
  it('carries the negative log probability unchanged', () => {
    const transcript = expectOk(normaliseTranscript(turboOutput(), TURBO!));

    expect(transcript.spans[0]?.confidence).toBe(-0.21);
    expect(transcript.confidenceScale).toBe('log-probability');
  });

  it('reads the detected language from its nested info object', () => {
    expect(expectOk(normaliseTranscript(turboOutput(), TURBO!)).detectedLanguage).toBe('en');
  });

  it('works when the info object is absent', () => {
    const output = turboOutput();
    delete output['transcription_info'];

    expect(expectOk(normaliseTranscript(output, TURBO!)).detectedLanguage).toBeUndefined();
  });

  it('returns the transcript when there are no segments at all', () => {
    const transcript = expectOk(normaliseTranscript(turboOutput({ segments: [] }), TURBO!));

    expect(transcript.text).toBeTruthy();
    expect(transcript.spans).toEqual([]);
    // Not declared beside an empty list: that would describe a breakdown the visitor cannot see.
    expect(transcript.timestampGranularity).toBeUndefined();
  });
});

describe('the original Whisper envelope', () => {
  it('reads per-word spans from the words array', () => {
    const transcript = expectOk(normaliseTranscript(whisperOutput(), WHISPER!));

    expect(transcript.spans).toHaveLength(2);
    expect(transcript.spans[0]).toMatchObject({ text: 'Hello', startSeconds: 0 });
    expect(transcript.timestampGranularity).toBe('word');
  });

  // Its output schema declares no confidence field at all, so the panel must not label a column
  // that would be empty.
  it('reports no confidence scale, because the model returns none', () => {
    const transcript = expectOk(normaliseTranscript(whisperOutput(), WHISPER!));

    expect(transcript.confidenceScale).toBeUndefined();
    expect(transcript.spans[0]?.confidence).toBeUndefined();
  });

  // The key is `word` here and `text` in turbo's segments. Reading the wrong one would produce an
  // empty breakdown against a perfectly valid response.
  it('reads the word key rather than a text key', () => {
    const output = whisperOutput({ words: [{ text: 'wrong', start: 0, end: 1 }] });

    expect(expectOk(normaliseTranscript(output, WHISPER!)).spans).toEqual([]);
  });
});

describe('the Nova 3 envelope', () => {
  it('reads the transcript from four levels of nesting', () => {
    const transcript = expectOk(normaliseTranscript(novaOutput(), NOVA!));

    expect(transcript.text).toBe('Hello there');
    expect(transcript.spans).toHaveLength(2);
  });

  // `transcript`, not `text`. This is the single most likely mistake in the whole normaliser, and
  // it would fail silently rather than loudly.
  it('reads the transcript key rather than a text key', () => {
    const output = novaOutput({ transcript: undefined, text: 'Hello there' });

    expect(normaliseTranscript(output, NOVA!).ok).toBe(false);
  });

  it('carries a genuine probability and labels the scale', () => {
    const transcript = expectOk(normaliseTranscript(novaOutput(), NOVA!));

    expect(transcript.spans[0]?.confidence).toBe(0.99);
    expect(transcript.confidenceScale).toBe('probability');
  });

  it('reads speaker labels when diarization was applied', () => {
    const output = novaOutput({
      words: [
        { word: 'Hello', start: 0, end: 0.5, confidence: 0.99, speaker: 0 },
        { word: 'there', start: 0.5, end: 0.9, confidence: 0.94, speaker: 1 }
      ]
    });
    const transcript = expectOk(normaliseTranscript(output, NOVA!));

    expect(transcript.diarized).toBe(true);
    expect(transcript.spans.map((span) => span.speaker)).toEqual([0, 1]);
  });

  it('reports no diarization when no speaker labels were returned', () => {
    expect(expectOk(normaliseTranscript(novaOutput(), NOVA!)).diarized).toBe(false);
  });

  // Alternatives are ranked, so anything past the first is a lower-confidence reading that would
  // be wrong to present or concatenate.
  it('takes only the first alternative', () => {
    const output = {
      results: {
        channels: [
          {
            alternatives: [
              { transcript: 'the best reading', words: [] },
              { transcript: 'a worse reading', words: [] }
            ]
          }
        ]
      }
    };

    expect(expectOk(normaliseTranscript(output, NOVA!)).text).toBe('the best reading');
  });

  it('refuses an envelope with no channels', () => {
    expect(normaliseTranscript({ results: {} }, NOVA!).ok).toBe(false);
  });

  it('refuses an envelope with an empty alternatives list', () => {
    const output = { results: { channels: [{ alternatives: [] }] } };
    expect(normaliseTranscript(output, NOVA!).ok).toBe(false);
  });
});

describe('choosing the envelope from the descriptor', () => {
  // Reading the declared shape rather than probing for keys is what turns a contract change into a
  // loud refusal instead of a subtly wrong transcript.
  it('refuses a Nova response handed to a Whisper descriptor', () => {
    expect(normaliseTranscript(novaOutput(), TURBO!).ok).toBe(false);
  });

  it('refuses a Whisper response handed to the Nova descriptor', () => {
    expect(normaliseTranscript(turboOutput(), NOVA!).ok).toBe(false);
  });
});

describe('refusing unusable output', () => {
  it('refuses a non-object', () => {
    expect(normaliseTranscript('a transcript', TURBO!)).toEqual({
      ok: false,
      reason: 'unrecognised_shape'
    });
    expect(normaliseTranscript(null, TURBO!).ok).toBe(false);
    expect(normaliseTranscript([], TURBO!).ok).toBe(false);
  });

  it('refuses an object with no transcript field at all', () => {
    expect(normaliseTranscript({ unexpected: 'envelope' }, TURBO!)).toEqual({
      ok: false,
      reason: 'missing_transcript'
    });
  });

  // Distinguished from a missing field so a log says whether the envelope was wrong or merely
  // empty. Silent audio is a different event from a changed response format, and only one of them
  // is a fault.
  it('distinguishes an empty transcript from a missing one', () => {
    expect(normaliseTranscript({ text: '' }, TURBO!)).toEqual({
      ok: false,
      reason: 'empty_transcript'
    });
    expect(normaliseTranscript({ text: '   ' }, TURBO!)).toEqual({
      ok: false,
      reason: 'empty_transcript'
    });
  });
});

describe('span hygiene', () => {
  it('drops an entry missing its timing', () => {
    const output = turboOutput({
      segments: [
        { start: 0, end: 1, text: 'kept' },
        { text: 'no timing' },
        { start: 2, text: 'no end' }
      ]
    });

    expect(expectOk(normaliseTranscript(output, TURBO!)).spans).toHaveLength(1);
  });

  it('drops an entry with no text', () => {
    const output = turboOutput({ segments: [{ start: 0, end: 1, text: '  ' }] });
    expect(expectOk(normaliseTranscript(output, TURBO!)).spans).toEqual([]);
  });

  // `NaN` and `Infinity` both serialise to `null` and would reach the page as a missing timestamp
  // rather than as the broken value they are.
  it('drops an entry whose timing is not finite', () => {
    const output = turboOutput({
      segments: [
        { start: Number.NaN, end: 1, text: 'bad start' },
        { start: 0, end: Number.POSITIVE_INFINITY, text: 'bad end' }
      ]
    });

    expect(expectOk(normaliseTranscript(output, TURBO!)).spans).toEqual([]);
  });

  it('clamps a negative start to zero', () => {
    const output = turboOutput({ segments: [{ start: -5, end: 1, text: 'early' }] });
    expect(expectOk(normaliseTranscript(output, TURBO!)).spans[0]?.startSeconds).toBe(0);
  });

  // A negative duration would render as a span that ends before it begins.
  it('never produces an end before its start', () => {
    const output = turboOutput({ segments: [{ start: 5, end: 2, text: 'reversed' }] });
    const span = expectOk(normaliseTranscript(output, TURBO!)).spans[0];

    expect(span?.endSeconds).toBeGreaterThanOrEqual(span?.startSeconds ?? 0);
  });

  // A single out-of-order entry would make a transcript appear to jump backwards, which reads as
  // corruption rather than as a provider quirk.
  it('orders spans by start time', () => {
    const output = turboOutput({
      segments: [
        { start: 4, end: 5, text: 'third' },
        { start: 0, end: 1, text: 'first' },
        { start: 2, end: 3, text: 'second' }
      ]
    });

    expect(expectOk(normaliseTranscript(output, TURBO!)).spans.map((s) => s.text)).toEqual([
      'first',
      'second',
      'third'
    ]);
  });

  it('ignores a non-object entry in the array', () => {
    const output = turboOutput({
      segments: ['nonsense', 42, null, { start: 0, end: 1, text: 'ok' }]
    });
    expect(expectOk(normaliseTranscript(output, TURBO!)).spans).toHaveLength(1);
  });

  it('ignores a timed array that is not an array', () => {
    const transcript = expectOk(normaliseTranscript(turboOutput({ segments: 'nope' }), TURBO!));

    expect(transcript.text).toBeTruthy();
    expect(transcript.spans).toEqual([]);
  });

  // An hour of per-word timings is tens of thousands of objects. Capping bounds the response
  // without touching the transcript text, which is returned in full regardless.
  it('caps the number of spans', () => {
    const words = Array.from({ length: MAX_TRANSCRIPT_SPANS + 500 }, (_unused, index) => ({
      word: `w${index}`,
      start: index,
      end: index + 1
    }));
    const transcript = expectOk(normaliseTranscript(whisperOutput({ words }), WHISPER!));

    expect(transcript.spans).toHaveLength(MAX_TRANSCRIPT_SPANS);
    // The text is untouched by the cap: it is the result, and the spans are a view of it.
    expect(transcript.text).toBe('Hello there');
  });

  it('drops a fractional or negative speaker label', () => {
    const output = novaOutput({
      words: [
        { word: 'a', start: 0, end: 1, speaker: 1.5 },
        { word: 'b', start: 1, end: 2, speaker: -1 }
      ]
    });

    expect(expectOk(normaliseTranscript(output, NOVA!)).diarized).toBe(false);
  });
});

describe('the word count', () => {
  // Counted here rather than taken from the provider's own `word_count`, so the figure means the
  // same thing for every model — which is the only reason to show it.
  it('counts words rather than trusting the provider\u2019s own figure', () => {
    const transcript = expectOk(
      normaliseTranscript(turboOutput({ text: 'one two three', word_count: 99 }), TURBO!)
    );

    expect(transcript.wordCount).toBe(3);
  });

  it('collapses repeated whitespace', () => {
    const transcript = expectOk(
      normaliseTranscript(turboOutput({ text: '  one   two  ' }), TURBO!)
    );

    expect(transcript.wordCount).toBe(2);
  });
});
