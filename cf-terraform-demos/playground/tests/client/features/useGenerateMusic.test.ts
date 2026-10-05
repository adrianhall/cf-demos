/**
 * @file Tests for the Generate Music composable. Two areas carry most of the weight. **Re-settling
 *   the controls on a model change.** The two reviewed models disagree about whether a length
 *   control exists, whether lyrics exist, and what the format names are — and their format enums
 *   share no value at all. A value carried across a model change would therefore stage a request
 *   the server refuses, so every control is asserted to reset unless the new model genuinely
 *   publishes it. **The cost estimate, in two units.** It is asserted to move with the length
 *   control for one model and _not_ to move for the other, because a test that only checked
 *   "produces a figure" would pass against an implementation that had collapsed the two billing
 *   models into one.
 */

import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import {
  musicFailureMessage,
  useGenerateMusic
} from '../../../src/client/features/generate-music/useGenerateMusic';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import {
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS,
  type GenerateMusicResponse
} from '../../../src/shared/generate-music';

/**
 * A per-second model with a length control and no lyrics field, matching ElevenLabs Music v2.
 */
const PER_SECOND: CatalogueModel = {
  id: 'test/music-seconds',
  name: 'Test Per-Second',
  provider: 'third-party',
  task: 'generate-music',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/per-second',
  musicControls: {
    instrumentalParameterName: 'force_instrumental',
    instrumentalParameterRequired: false,
    lyrics: 'unsupported',
    lengthParameterName: 'music_length_ms',
    lengthUnit: 'milliseconds',
    lengthSeconds: { min: 3, max: 120, step: 1, default: 15 },
    formatParameterName: 'output_format',
    formats: ['mp3_44100_128', 'mp3_44100_192'],
    defaultFormat: 'mp3_44100_128',
    seed: true,
    pricing: { unit: 'audio-second', pricePerOutputSecondUsd: 0.0025 },
    outputHosts: ['examples.aig.cloudflare.com']
  }
};

/**
 * A per-track model with no length control, lyrics support, and a disjoint format list, matching
 * MiniMax Music 2.6. The disjoint formats are the point: they are what makes carrying a format
 * across a model change dangerous rather than merely untidy.
 */
const PER_TRACK: CatalogueModel = {
  id: 'test/music-track',
  name: 'Test Per-Track',
  provider: 'third-party',
  task: 'generate-music',
  pricingUnit: 'track',
  documentationUrl: 'https://example.invalid/per-track',
  musicControls: {
    instrumentalParameterName: 'is_instrumental',
    instrumentalParameterRequired: true,
    lyrics: 'optional',
    lyricsParameterName: 'lyrics',
    lyricsOptimizerParameterName: 'lyrics_optimizer',
    lyricsOptimizerRequired: true,
    requiresLyricsForVocals: true,
    formatParameterName: 'format',
    formats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    seed: false,
    pricing: { unit: 'track', pricePerTrackUsd: 0.15, pricePerLyricsGenerationUsd: 0.01 },
    outputHosts: ['tracks.example.invalid']
  }
};

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<GenerateMusicResponse> = {}): GenerateMusicResponse {
  return {
    track: {
      base64: 'SUQzAwA=',
      mediaType: 'audio/mpeg',
      byteLength: 2_048,
      sourceHost: 'examples.aig.cloudflare.com'
    },
    receipt: {
      runId: 'run-1',
      task: 'generate-music',
      model: PER_SECOND.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 18_000,
      startedAt: new Date().toISOString()
    },
    applied: {
      model: PER_SECOND.id,
      prompt: 'ambient piano',
      instrumental: true,
      lyricsSource: 'none',
      lengthSeconds: 15,
      format: 'mp3_44100_128',
      pricingUnit: 'audio-second',
      estimatedCostUsd: 0.0375,
      costBasis: '$0.0025 per second of output audio × 15 seconds.'
    },
    ...overrides
  };
}

/**
 * Builds the composable with an injected transport.
 *
 * @param models Catalogue models to offer.
 * @param transport Transport to use.
 * @returns The composable result plus the transport, for assertions on what was sent.
 */
function build(
  models: CatalogueModel[] = [PER_SECOND, PER_TRACK],
  transport = vi.fn().mockResolvedValue(response())
) {
  const result = useGenerateMusic({
    models: ref(models),
    compose: transport,
    // Resolve polls immediately rather than waiting seconds of real time.
    runOptions: { sleep: async () => undefined }
  });
  // Exposed as `transport` rather than merged over the composable's own `generate` action, which it
  // would otherwise shadow — leaving every test calling the mock directly instead of the code under
  // test, and passing for the wrong reason.
  return { ...result, transport };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
});

describe('selecting a model', () => {
  // The catalogue puts the cheap per-second model first deliberately, so defaulting to the first
  // reviewed model is also defaulting to the model a first exploratory click costs least on.
  it('defaults to the first reviewed model once the catalogue arrives', () => {
    expect(build().model.value).toBe(PER_SECOND.id);
  });

  it('exposes the selected model descriptor', () => {
    expect(build().selectedModel.value?.name).toBe('Test Per-Second');
  });

  it('offers no model when the catalogue is empty', () => {
    const panel = build([]);
    expect(panel.model.value).toBe('');
    expect(panel.selectedModel.value).toBeUndefined();
  });
});

describe('re-settling controls when the model changes', () => {
  // The dangerous case. The two format lists share no value at all, so a format carried across a
  // model change is guaranteed to be one the server refuses.
  it('clears a format the newly selected model does not publish', async () => {
    const panel = build();
    panel.format.value = 'mp3_44100_192';

    panel.model.value = PER_TRACK.id;
    await nextTick();

    expect(panel.format.value).toBeUndefined();
  });

  // Reset rather than clamped: a length valid for one model is not merely out of range for a model
  // with no length control — the field does not exist there, and the server refuses it.
  it('clears a chosen length when the new model has no length control', async () => {
    const panel = build();
    panel.lengthSeconds.value = 60;

    panel.model.value = PER_TRACK.id;
    await nextTick();

    expect(panel.lengthSeconds.value).toBeUndefined();
  });

  it('clears lyrics and the lyrics-writing flag when the new model has no lyrics field', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.instrumental.value = false;
    panel.lyrics.value = 'line one';
    panel.generateLyrics.value = false;

    panel.model.value = PER_SECOND.id;
    await nextTick();

    expect(panel.lyrics.value).toBe('');
    expect(panel.generateLyrics.value).toBe(false);
  });

  it('clears a seed when the new model accepts none', async () => {
    const panel = build();
    panel.seed.value = 1_234;

    panel.model.value = PER_TRACK.id;
    await nextTick();

    expect(panel.seed.value).toBeUndefined();
  });
});

describe('the cost estimate', () => {
  it('quotes the per-second price multiplied by the chosen length', () => {
    const panel = build();
    panel.lengthSeconds.value = 30;

    expect(panel.estimatedCostUsd.value).toBeCloseTo(0.075, 10);
    expect(panel.pricingUnit.value).toBe('audio-second');
  });

  it('falls back to the model\u2019s declared default length', () => {
    // 15 seconds at $0.0025, which is the default the server would fill in.
    expect(build().estimatedCostUsd.value).toBeCloseTo(0.0375, 10);
  });

  // The assertion that catches the two billing models having been collapsed into one: the figure
  // moves with the length for one model and does not for the other.
  it('moves with the length for a per-second model and not for a per-track one', async () => {
    const panel = build();

    panel.lengthSeconds.value = 30;
    const thirty = panel.estimatedCostUsd.value;
    panel.lengthSeconds.value = 60;
    expect(panel.estimatedCostUsd.value).not.toBeCloseTo(thirty ?? 0, 10);

    panel.model.value = PER_TRACK.id;
    await nextTick();
    const flat = panel.estimatedCostUsd.value;
    expect(flat).toBeCloseTo(0.15, 10);
    // There is no length control to move, and the figure is the same either way.
    expect(panel.lengthSeconds.value).toBeUndefined();
    expect(panel.pricingUnit.value).toBe('track');
  });

  it('adds the separate lyrics charge for the model that bills one', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.instrumental.value = false;
    panel.generateLyrics.value = true;
    await nextTick();

    expect(panel.estimatedCostUsd.value).toBeCloseTo(0.16, 10);
  });

  // The sentence names the unit, because the figure alone is ambiguous between the two models — and
  // it states explicitly that this is not a token charge.
  it('explains the basis in the selected model\u2019s own unit', async () => {
    const panel = build();
    panel.lengthSeconds.value = 30;
    expect(panel.costBasis.value).toContain('per second of output audio');
    expect(panel.costBasis.value).toMatch(/not by tokens/iu);

    panel.model.value = PER_TRACK.id;
    await nextTick();
    expect(panel.costBasis.value).toContain('per track');
    expect(panel.costBasis.value).toMatch(/not by tokens/iu);
  });

  it('quotes nothing before the catalogue arrives', () => {
    const panel = build([]);
    expect(panel.estimatedCostUsd.value).toBeUndefined();
    expect(panel.costBasis.value).toBeUndefined();
    expect(panel.pricingUnit.value).toBeUndefined();
  });
});

describe('deciding whether the panel can be submitted', () => {
  it('refuses an empty prompt and says why', () => {
    const panel = build();
    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/describe the music/iu);
  });

  it('allows a prompt within the limit', () => {
    const panel = build();
    panel.prompt.value = 'ambient piano';
    expect(panel.canGenerate.value).toBe(true);
    expect(panel.blockedReason.value).toBeUndefined();
  });

  it('refuses an over-long prompt', () => {
    const panel = build();
    panel.prompt.value = 'a'.repeat(MAX_MUSIC_PROMPT_CHARACTERS + 1);
    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/shorten the prompt/iu);
  });

  it('refuses over-long lyrics', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;
    panel.lyrics.value = 'a'.repeat(MAX_MUSIC_LYRICS_CHARACTERS + 1);

    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/shorten the lyrics/iu);
  });

  it('refuses lyrics on an instrumental track', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = true;
    panel.lyrics.value = 'line one';

    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/instrumental track has no vocals/iu);
  });

  it('refuses supplying lyrics and asking the model to write them at once', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;
    panel.lyrics.value = 'line one';
    panel.generateLyrics.value = true;

    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/choose one/iu);
  });

  // The provider's own refusal, mirrored from the descriptor so the visitor is told before
  // spending. On a per-track model that is the difference between a free refusal and fifteen cents.
  it('refuses a vocal track with no words for the model that requires them', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;

    expect(panel.canGenerate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/will not sing without words/iu);
    expect(panel.blockedReason.value).toContain(PER_TRACK.name);
  });

  // The same state is perfectly valid for the model that describes vocals in the prompt, which is
  // what proves the rule is read from the descriptor rather than applied to the panel.
  it('allows a vocal track with no words for the model that does not require them', () => {
    const panel = build();
    panel.prompt.value = 'a soft vocal ambient piece';
    panel.instrumental.value = false;

    expect(panel.canGenerate.value).toBe(true);
  });

  it('refuses a second run while one is in flight', async () => {
    let release: (value: GenerateMusicResponse) => void = () => undefined;
    const transport = vi.fn(
      () =>
        new Promise<GenerateMusicResponse>((resolve) => {
          release = resolve;
        })
    );
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    const running = panel.generate();
    await nextTick();
    expect(panel.generating.value).toBe(true);
    expect(panel.canGenerate.value).toBe(false);

    release(response());
    await running;
    expect(panel.generating.value).toBe(false);
  });
});

describe('what the composable sends', () => {
  it('sends only the controls the selected model declares', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';
    panel.lengthSeconds.value = 30;
    panel.seed.value = 7;

    await panel.generate();

    expect(transport).toHaveBeenCalledWith(
      {
        prompt: 'ambient piano',
        model: PER_SECOND.id,
        runId: 'run-1',
        instrumental: true,
        lengthSeconds: 30,
        seed: 7
      },
      expect.anything()
    );
  });

  it('sends no length or seed for the model that accepts neither', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;
    panel.lyrics.value = 'line one';

    await panel.generate();

    const sent = transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent['lengthSeconds']).toBeUndefined();
    expect(sent['seed']).toBeUndefined();
    expect(sent['lyrics']).toBe('line one');
  });

  it('trims the prompt and the lyrics before sending them', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = '  folk ballad  ';
    panel.instrumental.value = false;
    panel.lyrics.value = '  line one  ';

    await panel.generate();

    const sent = transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent['prompt']).toBe('folk ballad');
    expect(sent['lyrics']).toBe('line one');
  });

  it('does nothing when the panel cannot be submitted', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const panel = build([PER_SECOND, PER_TRACK], transport);

    await panel.generate();

    expect(transport).not.toHaveBeenCalled();
  });
});

describe('a completed run', () => {
  it('exposes the track, a playable URI, the receipt, and the applied controls', async () => {
    const panel = build();
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.track.value?.mediaType).toBe('audio/mpeg');
    expect(panel.audioUri.value).toBe('data:audio/mpeg;base64,SUQzAwA=');
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.pricingUnit).toBe('audio-second');
  });

  // The words shown beside a player must be the ones *that run* was given, not whatever the form
  // says by the time the response arrives.
  it('holds the lyrics the run was given rather than the current form value', async () => {
    const transport = vi.fn().mockResolvedValue(
      response({
        applied: { ...response().applied, lyricsSource: 'caller', lyricsCharacterCount: 8 }
      })
    );
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;
    panel.lyrics.value = 'line one';

    await panel.generate();
    panel.lyrics.value = 'something else entirely';

    expect(panel.renderedLyrics.value).toBe('line one');
  });

  // A model that wrote its own lyrics returns audio and nothing else, so there is nothing to show.
  // Reporting that as absence rather than as an empty string is what lets the player explain it.
  it('holds no lyrics when the model wrote them and did not return them', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(response({ applied: { ...response().applied, lyricsSource: 'model' } }));
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = 'folk ballad';
    panel.instrumental.value = false;
    panel.generateLyrics.value = true;

    await panel.generate();

    expect(panel.renderedLyrics.value).toBeUndefined();
  });

  it('records the run in the session ledger', async () => {
    const panel = build();
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.receipt.value?.costStatus).toBe('pending');
  });
});

describe('failures', () => {
  // The expected outcome on an unfunded account. Classified from the `503` status rather than from
  // the server's wording, because the wording is not a contract and the status is.
  it('presents a 503 as the actionable credit failure', async () => {
    const transport = vi.fn().mockRejectedValue(new ApiError(503, 'Add AI Gateway credits.'));
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.failureReason.value).toBe('insufficient-credit');
    expect(panel.error.value).toMatch(/no prepaid AI Gateway credit/iu);
    // Says plainly that nothing was charged, which is what makes the empty session meter consistent
    // rather than merely reassuring.
    expect(panel.error.value).toMatch(/nothing was charged/iu);
    expect(panel.track.value).toBeUndefined();
  });

  // The message has to tell a visitor to top up rather than to retry: retrying without credit fails
  // identically every time, and the generic wording would be actively misleading.
  it('tells a visitor to add credit rather than to retry', () => {
    const message = musicFailureMessage('insufficient-credit');
    expect(message).toMatch(/add credit/iu);
    expect(message).toMatch(/retrying before then will fail the same way/iu);
    // States the reason there is no fallback, which is the catalogue fact behind the whole phase.
    expect(message).toMatch(/no Cloudflare-hosted music model/iu);
  });

  it('presents another failure as a provider failure that may be worth retrying', async () => {
    const transport = vi.fn().mockRejectedValue(new ApiError(502, 'The provider failed.'));
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.failureReason.value).toBe('provider-failure');
    expect(panel.error.value).toBe('The provider failed.');
    expect(musicFailureMessage('provider-failure')).toMatch(/trying again may work/iu);
  });

  it('reports a transport failure in plain terms', async () => {
    const transport = vi.fn().mockRejectedValue(new TypeError('network down'));
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.error.value).toMatch(/check your connection/iu);
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
  it('leaves no error after the visitor cancels', async () => {
    const transport = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();

    expect(panel.error.value).toBeNull();
    expect(panel.failureReason.value).toBeUndefined();
    expect(panel.generating.value).toBe(false);
  });

  it('aborts the request in flight when cancelled', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const transport = vi.fn(async (_request: unknown, signal?: AbortSignal) => {
      signals.push(signal);
      return response();
    });
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('clears a previous failure when a new run starts', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'Add AI Gateway credits.'))
      .mockResolvedValueOnce(response());
    const panel = build([PER_SECOND, PER_TRACK], transport);
    panel.prompt.value = 'ambient piano';

    await panel.generate();
    expect(panel.failureReason.value).toBe('insufficient-credit');

    await panel.generate();
    expect(panel.failureReason.value).toBeUndefined();
    expect(panel.error.value).toBeNull();
  });
});

describe('counting the input', () => {
  // Counted in code points rather than UTF-16 units, matching the server's own limits, so the
  // editor's counter cannot disagree with validation.
  it('counts prompt and lyrics in code points', async () => {
    const panel = build();
    panel.model.value = PER_TRACK.id;
    await nextTick();

    panel.prompt.value = '  \u{1F3B5}\u{1F3B5}  ';
    panel.instrumental.value = false;
    panel.lyrics.value = '\u{1F3B5}';

    expect(panel.promptCharacterCount.value).toBe(2);
    expect(panel.lyricsCharacterCount.value).toBe(1);
  });
});
