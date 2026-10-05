/**
 * @file Generate Music domain tests. Three groups of assertions here are the phase's substance
 *   rather than routine coverage. **The per-descriptor control rules.** The two reviewed models
 *   disagree about whether a track length exists, whether lyrics exist, and how every shared
 *   control is spelled. Each rule is asserted in both directions — accepted for the model that
 *   declares it, refused for the model that does not — because a validator that merely dropped the
 *   unsupported value would pass a one-directional test while teaching a visitor that the control
 *   did nothing. **The lyrics combinations.** One of them is a reimplementation of a provider
 *   refusal, and it is checked locally so the refusal happens before the charge. On a per-track
 *   model that is the difference between a free `400` and fifteen cents. **The cost arithmetic, in
 *   two units.** The per-second and per-track branches are asserted separately and then asserted to
 *   be _different kinds of answer_: one moves with the requested length and the other does not. A
 *   test that only checked "returns a number" would pass against an implementation that had quietly
 *   collapsed the two.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_MUSIC_LENGTH_SECONDS,
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS,
  MIN_MUSIC_LENGTH_SECONDS,
  describeMusicCostBasis,
  estimateMusicCostUsd,
  isPlayableMusicMediaType,
  MUSIC_FILE_EXTENSIONS,
  type MusicPricing
} from '../../../src/shared/generate-music';
import {
  buildGenerateMusicInput,
  describeAppliedMusicControls,
  estimateMusicCostForRequest,
  musicLyricsSource,
  validateGenerateMusicRequest
} from '../../../src/worker/domain/generate-music';
import { modelsForTask } from '../../../src/worker/domain/models';
import { problemWithStatus, thrownBy } from '../support/problem-details';

/**
 * The reviewed music models, in catalogue order: the per-second model first.
 */
const [ELEVENLABS, MINIMAX] = modelsForTask('generate-music');

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'b00000b5-1111-4222-8333-444455556666';

/**
 * Builds a request body for the per-second model.
 *
 * @param overrides Fields to replace or add.
 * @returns The untrusted body to validate.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'A warm cinematic ambient piece with soft piano',
    model: ELEVENLABS!.id,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Builds a request body for the per-track model.
 *
 * @param overrides Fields to replace or add.
 * @returns The untrusted body to validate.
 */
function minimaxBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return body({ model: MINIMAX!.id, instrumental: true, ...overrides });
}

describe('the reviewed descriptors', () => {
  // The catalogue has no Cloudflare-hosted music model, which is why this panel sits after every
  // credit-free one. Asserting it keeps the README's claim and the code's behaviour in step: if a
  // hosted model is ever added, this test is the prompt to move the phase earlier.
  it('offers only third-party models, because no hosted music model exists', () => {
    expect(modelsForTask('generate-music').length).toBeGreaterThanOrEqual(2);
    for (const model of modelsForTask('generate-music')) {
      expect(model.provider, `${model.id} is third-party`).toBe('third-party');
    }
  });

  // The pricing units are the panel's whole subject. If both models ever declared the same unit the
  // comparison would be gone, and the UI's two cost sentences would be one sentence twice.
  it('declares two genuinely different billing units', () => {
    expect(ELEVENLABS?.pricingUnit).toBe('audio-second');
    expect(MINIMAX?.pricingUnit).toBe('track');
    expect(ELEVENLABS?.musicControls?.pricing.unit).toBe('audio-second');
    expect(MINIMAX?.musicControls?.pricing.unit).toBe('track');
  });

  // Neither declares a token price, and neither reports a token count. A descriptor that claimed to
  // be token-priced would invite exactly the derivation this panel exists to rule out.
  it('declares no model in this panel as token-priced', () => {
    for (const model of modelsForTask('generate-music')) {
      expect(model.pricingUnit).not.toBe('token');
    }
  });

  // Both are synchronous, which is the finding that decided the panel's whole shape: no job handle
  // in either schema means no Workflow, no polling route, and no storage product.
  it('declares both models as synchronous, so no job infrastructure is needed', () => {
    for (const model of modelsForTask('generate-music')) {
      expect(model.invocation, `${model.id} invocation`).toBe('synchronous');
    }
  });

  // The disagreements, asserted as data. Each one is a request the other model would reject.
  it('declares disjoint output formats and differently named instrumental flags', () => {
    const left = ELEVENLABS!.musicControls!;
    const right = MINIMAX!.musicControls!;

    expect(left.instrumentalParameterName).toBe('force_instrumental');
    expect(right.instrumentalParameterName).toBe('is_instrumental');
    expect(left.formats.some((value) => right.formats.includes(value))).toBe(false);
  });

  it('declares a length control for one model and none for the other', () => {
    expect(ELEVENLABS?.musicControls?.lengthSeconds).toBeDefined();
    expect(MINIMAX?.musicControls?.lengthSeconds).toBeUndefined();
    expect(MINIMAX?.musicControls?.lengthParameterName).toBeUndefined();
  });

  it('declares lyrics support for one model and none for the other', () => {
    expect(ELEVENLABS?.musicControls?.lyrics).toBe('unsupported');
    expect(MINIMAX?.musicControls?.lyrics).toBe('optional');
  });

  // Every host is named explicitly, because the allowlist is what keeps the Worker from being a
  // general-purpose fetcher. An empty list for a URL-returning model would refuse every result.
  it('publishes an approved output host for each model', () => {
    for (const model of modelsForTask('generate-music')) {
      expect(model.musicControls?.outputHosts.length, `${model.id} hosts`).toBeGreaterThan(0);
    }
  });
});

describe('validating the prompt', () => {
  it('accepts a well-formed request and resolves the model defaults', () => {
    const request = validateGenerateMusicRequest(body());

    expect(request.prompt).toBe('A warm cinematic ambient piece with soft piano');
    expect(request.model.id).toBe(ELEVENLABS!.id);
    expect(request.format).toBe(ELEVENLABS!.musicControls!.defaultFormat);
    expect(request.lengthSeconds).toBe(ELEVENLABS!.musicControls!.lengthSeconds!.default);
    // Defaults to `false` rather than remaining undefined, so the lyrics rule has one reading.
    expect(request.instrumental).toBe(false);
    expect(request.generateLyrics).toBe(false);
  });

  it('trims the prompt', () => {
    expect(validateGenerateMusicRequest(body({ prompt: '  lo-fi piano  ' })).prompt).toBe(
      'lo-fi piano'
    );
  });

  it.each([undefined, '', '   ', 42, null])('rejects an unusable prompt %p', (prompt) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ prompt })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects a prompt beyond the character limit', () => {
    const oversized = 'a'.repeat(MAX_MUSIC_PROMPT_CHARACTERS + 1);
    expect(thrownBy(() => validateGenerateMusicRequest(body({ prompt: oversized })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
  // non-BMP character counts once. A prompt at exactly the limit must be accepted.
  it('counts the prompt in code points rather than UTF-16 units', () => {
    const emoji = '\u{1F3B5}'.repeat(MAX_MUSIC_PROMPT_CHARACTERS);
    expect(validateGenerateMusicRequest(body({ prompt: emoji })).prompt).toBe(emoji);
  });

  it.each([undefined, 'short', 'has spaces', 42])('rejects run identifier %p', (runId) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ runId })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it.each([undefined, '', '   ', 'not-a-model', 42])('rejects model %p', (model) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ model })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // Looking a model up by identifier alone is how a narrow task API turns into a generic
  // `{ model, input }` passthrough, so the panel and the identifier are resolved together.
  it('rejects a model registered against another panel', () => {
    expect(
      thrownBy(() => validateGenerateMusicRequest(body({ model: '@cf/deepgram/aura-2-en' })))
    ).toMatchObject(problemWithStatus(400));
  });

  it.each([null, 'text', 42, ['array']])('rejects a non-object body %p', (value) => {
    expect(thrownBy(() => validateGenerateMusicRequest(value))).toMatchObject(
      problemWithStatus(400)
    );
  });
});

describe('fields the caller may not supply', () => {
  // The actor comes from the verified Access identity. A body carrying one of these is attempting to
  // choose who the request — and the charge — is attributed to, which matters more here than on most
  // panels because every model spends prepaid credit.
  it.each(['user', 'email', 'actor', 'sub'])('rejects identity field %s', (field) => {
    expect(
      thrownBy(() => validateGenerateMusicRequest(body({ [field]: 'mallory@example.com' })))
    ).toMatchObject(problemWithStatus(400));
  });

  // The server establishes all of these from the bytes it received. `audio` and `audioUrl` matter
  // most: they are the obvious shape of an attempt to have this Worker fetch an arbitrary URL, which
  // is the one thing the host allowlist exists to prevent.
  it.each(['audio', 'audioUrl', 'mediaType', 'byteLength', 'durationSeconds', 'sourceHost'])(
    'rejects output-describing field %s',
    (field) => {
      expect(
        thrownBy(() =>
          validateGenerateMusicRequest(body({ [field]: 'https://evil.example/track.mp3' }))
        )
      ).toMatchObject(problemWithStatus(400));
    }
  );

  // Refused outright rather than having the field stripped, so a caller learns their attempt was
  // noticed instead of believing it worked.
  it('names the refused field in the error rather than silently dropping it', () => {
    const error = thrownBy(() =>
      validateGenerateMusicRequest(body({ audioUrl: 'https://evil.example/track.mp3' }))
    ) as { problemDetails: { detail: string } };

    expect(error.problemDetails.detail).toContain('audioUrl');
  });
});

describe('validating the track length', () => {
  it('accepts a length inside the model\u2019s declared range', () => {
    expect(validateGenerateMusicRequest(body({ lengthSeconds: 30 })).lengthSeconds).toBe(30);
  });

  it('accepts the declared boundaries', () => {
    expect(
      validateGenerateMusicRequest(body({ lengthSeconds: MIN_MUSIC_LENGTH_SECONDS })).lengthSeconds
    ).toBe(MIN_MUSIC_LENGTH_SECONDS);
    expect(
      validateGenerateMusicRequest(body({ lengthSeconds: MAX_MUSIC_LENGTH_SECONDS })).lengthSeconds
    ).toBe(MAX_MUSIC_LENGTH_SECONDS);
  });

  it.each([
    MIN_MUSIC_LENGTH_SECONDS - 1,
    MAX_MUSIC_LENGTH_SECONDS + 1,
    0,
    -5,
    10.5,
    Number.NaN,
    'thirty'
  ])('rejects length %p', (lengthSeconds) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ lengthSeconds })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // The important half. A model with no length field does not merely ignore the value — its schema
  // sets `additionalProperties: false`, so forwarding it would be a rejected request. Refusing it
  // here with a message naming the model is what turns an opaque provider error into something a
  // caller can act on.
  it('refuses a length for the model that has no length parameter', () => {
    const error = thrownBy(() =>
      validateGenerateMusicRequest(minimaxBody({ lengthSeconds: 30 }))
    ) as { problemDetails: { detail: string } };

    expect(error).toMatchObject(problemWithStatus(400));
    expect(error.problemDetails.detail).toContain('lengthSeconds');
    expect(error.problemDetails.detail).toContain(MINIMAX!.name);
  });

  it('reports no length at all for the model that chooses its own', () => {
    expect(validateGenerateMusicRequest(minimaxBody()).lengthSeconds).toBeUndefined();
  });
});

describe('validating the output format', () => {
  it('accepts a format the selected model declares', () => {
    expect(validateGenerateMusicRequest(body({ format: 'mp3_44100_192' })).format).toBe(
      'mp3_44100_192'
    );
    expect(validateGenerateMusicRequest(minimaxBody({ format: 'wav' })).format).toBe('wav');
  });

  // The clearest consequence of per-model format lists: `mp3` is valid for one model and invalid for
  // the other, and the two directions are asserted together so a loosened comparison fails here
  // rather than at the provider after the charge.
  it('refuses each model\u2019s format on the other model', () => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ format: 'mp3' })))).toMatchObject(
      problemWithStatus(400)
    );
    expect(
      thrownBy(() => validateGenerateMusicRequest(minimaxBody({ format: 'mp3_44100_128' })))
    ).toMatchObject(problemWithStatus(400));
  });

  // Compared exactly rather than case-insensitively. A provider validating against an enum treats a
  // different case as a different string, so normalising here would move a clear client error to an
  // opaque provider one.
  it.each(['MP3', 'Mp3_44100_128', 'opus_48000_64', 'flac', 42, null])(
    'rejects format %p',
    (format) => {
      expect(thrownBy(() => validateGenerateMusicRequest(body({ format })))).toMatchObject(
        problemWithStatus(400)
      );
    }
  );

  it('fills in the model\u2019s declared default when the caller omits one', () => {
    expect(validateGenerateMusicRequest(minimaxBody()).format).toBe('mp3');
  });
});

describe('validating lyrics', () => {
  it('accepts lyrics on the model that declares them', () => {
    const request = validateGenerateMusicRequest(
      minimaxBody({ instrumental: false, lyrics: 'line one\nline two' })
    );

    expect(request.lyrics).toBe('line one\nline two');
    expect(musicLyricsSource(request)).toBe('caller');
  });

  // The other direction, and the reason it is a refusal rather than a dropped field: ElevenLabs has
  // no lyrics property and would reject a request carrying one.
  it('refuses lyrics on the model that has no lyrics field', () => {
    const error = thrownBy(() =>
      validateGenerateMusicRequest(body({ instrumental: false, lyrics: 'la la la' }))
    ) as { problemDetails: { detail: string } };

    expect(error).toMatchObject(problemWithStatus(400));
    expect(error.problemDetails.detail).toContain('lyrics');
    expect(error.problemDetails.detail).toContain(ELEVENLABS!.name);
  });

  it('refuses the lyrics-writing flag on the model that cannot write lyrics', () => {
    expect(
      thrownBy(() => validateGenerateMusicRequest(body({ generateLyrics: true })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('accepts the lyrics-writing flag on the model that declares it', () => {
    const request = validateGenerateMusicRequest(
      minimaxBody({ instrumental: false, generateLyrics: true })
    );

    expect(request.generateLyrics).toBe(true);
    expect(musicLyricsSource(request)).toBe('model');
  });

  it('rejects lyrics beyond the character limit', () => {
    const oversized = 'a'.repeat(MAX_MUSIC_LYRICS_CHARACTERS + 1);
    expect(
      thrownBy(() =>
        validateGenerateMusicRequest(minimaxBody({ instrumental: false, lyrics: oversized }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it.each([42, null, ['line']])('rejects non-text lyrics %p', (lyrics) => {
    expect(
      thrownBy(() => validateGenerateMusicRequest(minimaxBody({ instrumental: false, lyrics })))
    ).toMatchObject(problemWithStatus(400));
  });

  // Empty lyrics are treated as absent rather than forwarded as `""`, because the provider's own
  // schema declares `minLength: 1` and would refuse the empty string.
  it('treats blank lyrics as absent rather than forwarding an empty string', () => {
    const request = validateGenerateMusicRequest(
      minimaxBody({ instrumental: false, generateLyrics: true, lyrics: '   ' })
    );

    expect(request.lyrics).toBeUndefined();
    expect(buildGenerateMusicInput(request)['lyrics']).toBeUndefined();
  });

  it('refuses lyrics on an instrumental track', () => {
    expect(
      thrownBy(() =>
        validateGenerateMusicRequest(minimaxBody({ instrumental: true, lyrics: 'la la' }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses asking for written lyrics on an instrumental track', () => {
    expect(
      thrownBy(() =>
        validateGenerateMusicRequest(minimaxBody({ instrumental: true, generateLyrics: true }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  // Supplying words *and* asking for words is a request with two answers, and the second is charged
  // for separately — so it is refused rather than resolved by precedence.
  it('refuses supplying lyrics and asking the model to write them at once', () => {
    expect(
      thrownBy(() =>
        validateGenerateMusicRequest(
          minimaxBody({ instrumental: false, lyrics: 'la la', generateLyrics: true })
        )
      )
    ).toMatchObject(problemWithStatus(400));
  });

  // The provider's own refusal, reimplemented so it happens before the charge rather than after it.
  // On a per-track model that is the difference between a free 400 and fifteen cents.
  it('refuses a vocal track with no words for the model that requires them', () => {
    const error = thrownBy(() =>
      validateGenerateMusicRequest(minimaxBody({ instrumental: false }))
    ) as { problemDetails: { detail: string } };

    expect(error).toMatchObject(problemWithStatus(400));
    expect(error.problemDetails.detail).toMatch(/will not sing without words/iu);
  });

  // The model with no lyrics field has no such requirement: vocals are described in the prompt, so a
  // vocal request with no lyrics is perfectly valid for it. Asserting both models in the same area
  // is what proves the rule is read from the descriptor rather than applied to the panel.
  it('allows a vocal track with no words for the model that describes vocals in the prompt', () => {
    const request = validateGenerateMusicRequest(body({ instrumental: false }));

    expect(request.instrumental).toBe(false);
    expect(musicLyricsSource(request)).toBe('none');
  });

  it('reports no lyrics for an instrumental track', () => {
    expect(musicLyricsSource(validateGenerateMusicRequest(body({ instrumental: true })))).toBe(
      'none'
    );
  });

  it.each([42, 'yes', null])('rejects a non-boolean instrumental flag %p', (instrumental) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ instrumental })))).toMatchObject(
      problemWithStatus(400)
    );
  });
});

describe('validating the seed', () => {
  it('accepts a seed on the model that declares one', () => {
    expect(validateGenerateMusicRequest(body({ seed: 1_234 })).seed).toBe(1_234);
  });

  // The provider's bound rather than this demo's: ElevenLabs declares an unsigned 32-bit maximum,
  // which is wider than the signed bound Create Video's models use.
  it('accepts the provider\u2019s full unsigned 32-bit range', () => {
    expect(validateGenerateMusicRequest(body({ seed: 0 })).seed).toBe(0);
    expect(validateGenerateMusicRequest(body({ seed: 4_294_967_295 })).seed).toBe(4_294_967_295);
  });

  it.each([-1, 4_294_967_296, 1.5, Number.NaN, 'seed', null])('rejects seed %p', (seed) => {
    expect(thrownBy(() => validateGenerateMusicRequest(body({ seed })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('refuses a seed on the model that accepts none', () => {
    expect(
      thrownBy(() => validateGenerateMusicRequest(minimaxBody({ seed: 1_234 })))
    ).toMatchObject(problemWithStatus(400));
  });
});

describe('building the provider input', () => {
  it('uses the per-second model\u2019s own parameter names and unit', () => {
    const input = buildGenerateMusicInput(
      validateGenerateMusicRequest(
        body({ lengthSeconds: 30, format: 'mp3_44100_192', instrumental: true, seed: 7 })
      )
    );

    expect(input).toEqual({
      prompt: 'A warm cinematic ambient piece with soft piano',
      output_format: 'mp3_44100_192',
      force_instrumental: true,
      // Milliseconds on the wire, seconds in the panel. The conversion happens once, from the unit
      // the descriptor declares.
      music_length_ms: 30_000,
      seed: 7
    });
  });

  it('uses the per-track model\u2019s own parameter names and sends no length', () => {
    const input = buildGenerateMusicInput(
      validateGenerateMusicRequest(minimaxBody({ instrumental: false, lyrics: 'line one' }))
    );

    expect(input).toEqual({
      prompt: 'A warm cinematic ambient piece with soft piano',
      format: 'mp3',
      is_instrumental: false,
      lyrics_optimizer: false,
      lyrics: 'line one'
    });
    expect(input['music_length_ms']).toBeUndefined();
    expect(input['duration']).toBeUndefined();
  });

  // Both reviewed schemas set `additionalProperties: false`, so a field the model did not declare is
  // a request it is entitled to reject. The input must therefore contain nothing beyond the
  // descriptor's own names.
  it('sends no field the selected model did not declare', () => {
    const elevenlabsKeys = Object.keys(
      buildGenerateMusicInput(validateGenerateMusicRequest(body({ instrumental: true })))
    );
    expect(elevenlabsKeys).not.toContain('is_instrumental');
    expect(elevenlabsKeys).not.toContain('lyrics');
    expect(elevenlabsKeys).not.toContain('lyrics_optimizer');
    expect(elevenlabsKeys).not.toContain('format');

    const minimaxKeys = Object.keys(
      buildGenerateMusicInput(validateGenerateMusicRequest(minimaxBody()))
    );
    expect(minimaxKeys).not.toContain('force_instrumental');
    expect(minimaxKeys).not.toContain('output_format');
    expect(minimaxKeys).not.toContain('seed');
    expect(minimaxKeys).not.toContain('music_length_ms');
  });

  // A required boolean is sent even when it is `false`: omitting a required property is a malformed
  // request, not a defaulted one. The optional flag on the other model is omitted instead, which is
  // the mirror image of the same rule.
  it('always sends a required flag and omits an optional one', () => {
    const minimax = buildGenerateMusicInput(validateGenerateMusicRequest(minimaxBody()));
    expect(minimax['is_instrumental']).toBe(true);
    expect(minimax['lyrics_optimizer']).toBe(false);

    const elevenlabs = buildGenerateMusicInput(
      validateGenerateMusicRequest(body({ instrumental: false }))
    );
    expect(Object.hasOwn(elevenlabs, 'force_instrumental')).toBe(false);
  });

  it('sends the lyrics-writing flag when it was asked for', () => {
    const input = buildGenerateMusicInput(
      validateGenerateMusicRequest(minimaxBody({ instrumental: false, generateLyrics: true }))
    );

    expect(input['lyrics_optimizer']).toBe(true);
    expect(Object.hasOwn(input, 'lyrics')).toBe(false);
  });
});

describe('estimating the cost', () => {
  /**
   * The per-second pricing, as the reviewed descriptor declares it.
   */
  const perSecond: MusicPricing = { unit: 'audio-second', pricePerOutputSecondUsd: 0.0025 };

  /**
   * The per-track pricing, as the reviewed descriptor declares it.
   */
  const perTrack: MusicPricing = {
    unit: 'track',
    pricePerTrackUsd: 0.15,
    pricePerLyricsGenerationUsd: 0.01
  };

  it('multiplies the per-second price by the requested length', () => {
    expect(estimateMusicCostUsd(perSecond, 30, false)).toBeCloseTo(0.075, 10);
    expect(estimateMusicCostUsd(perSecond, 10, false)).toBeCloseTo(0.025, 10);
  });

  it('charges a flat price per track whatever the length', () => {
    expect(estimateMusicCostUsd(perTrack, undefined, false)).toBeCloseTo(0.15, 10);
    // The length is ignored rather than quietly used, because the model has no length control and
    // charges the same either way.
    expect(estimateMusicCostUsd(perTrack, 120, false)).toBeCloseTo(0.15, 10);
  });

  it('adds the separate lyrics charge only for the model that bills one', () => {
    expect(estimateMusicCostUsd(perTrack, undefined, true)).toBeCloseTo(0.16, 10);
    // The per-second model has no lyrics capability, so asking cannot add a charge.
    expect(estimateMusicCostUsd(perSecond, 30, true)).toBeCloseTo(0.075, 10);
  });

  // The assertion that would catch the two branches having been collapsed into one: the per-second
  // estimate moves with the requested length and the per-track estimate does not. A test checking
  // only that each returns a number would pass against an implementation that had merged them.
  it('makes one unit length-sensitive and the other length-insensitive', () => {
    expect(estimateMusicCostUsd(perSecond, 60, false)).not.toBeCloseTo(
      estimateMusicCostUsd(perSecond, 30, false),
      10
    );
    expect(estimateMusicCostUsd(perTrack, 60, false)).toBeCloseTo(
      estimateMusicCostUsd(perTrack, 30, false),
      10
    );
  });

  // The crossover is worth pinning because it is the comparison the panel invites: at sixty seconds
  // the per-second model costs exactly what the per-track model charges for any length.
  it('meets the per-track price at sixty seconds', () => {
    expect(estimateMusicCostUsd(perSecond, 60, false)).toBeCloseTo(
      estimateMusicCostUsd(perTrack, undefined, false),
      10
    );
  });

  it('describes each basis in terms of its own unit, and never in tokens', () => {
    const second = describeMusicCostBasis(perSecond, 30, false);
    expect(second).toContain('per second of output audio');
    expect(second).toContain('30 seconds');
    expect(second).toMatch(/not by tokens/iu);

    const flat = describeMusicCostBasis(perTrack, undefined, true);
    expect(flat).toContain('per track');
    expect(flat).toContain('generating the lyrics');
    expect(flat).toMatch(/not by tokens/iu);
  });

  it('estimates from a validated request using its own descriptor', () => {
    expect(
      estimateMusicCostForRequest(validateGenerateMusicRequest(body({ lengthSeconds: 20 })))
    ).toBeCloseTo(0.05, 10);
    expect(estimateMusicCostForRequest(validateGenerateMusicRequest(minimaxBody()))).toBeCloseTo(
      0.15,
      10
    );
  });
});

describe('describing the applied controls', () => {
  it('reports the per-second model\u2019s settings, unit, and estimate', () => {
    const applied = describeAppliedMusicControls(
      validateGenerateMusicRequest(body({ lengthSeconds: 30, instrumental: true }))
    );

    expect(applied).toMatchObject({
      model: ELEVENLABS!.id,
      instrumental: true,
      lyricsSource: 'none',
      lengthSeconds: 30,
      pricingUnit: 'audio-second'
    });
    expect(applied.estimatedCostUsd).toBeCloseTo(0.075, 10);
    expect(applied.costBasis).toContain('per second of output audio');
  });

  it('reports no length for the model that chooses its own', () => {
    const applied = describeAppliedMusicControls(validateGenerateMusicRequest(minimaxBody()));

    expect(applied.lengthSeconds).toBeUndefined();
    expect(applied.pricingUnit).toBe('track');
  });

  // The words themselves are deliberately not echoed: the browser already has them, and a server
  // that returned a visitor's content back to them would put it in one more place for no benefit.
  it('reports the lyrics length and origin without echoing the lyrics', () => {
    const applied = describeAppliedMusicControls(
      validateGenerateMusicRequest(minimaxBody({ instrumental: false, lyrics: 'line one' }))
    );

    expect(applied.lyricsSource).toBe('caller');
    expect(applied.lyricsCharacterCount).toBe(8);
    expect(JSON.stringify(applied)).not.toContain('line one');
  });

  // The prompt *is* echoed, because the panel uses it as the player's accessible name — a caption
  // for the result rather than retained content.
  it('echoes the prompt so the result can be labelled with what was asked for', () => {
    expect(describeAppliedMusicControls(validateGenerateMusicRequest(body())).prompt).toBe(
      'A warm cinematic ambient piece with soft piano'
    );
  });
});

describe('the playback allowlist', () => {
  it.each(['audio/mpeg', 'audio/wav'])('plays %s', (mediaType) => {
    expect(isPlayableMusicMediaType(mediaType)).toBe(true);
  });

  // Opus in an Ogg container is a valid ElevenLabs output format and is deliberately not offered,
  // because a browser would not reliably play it from a `data:` URI — so paying for one would be
  // paying for a track the panel then refuses to render.
  it.each(['audio/ogg', 'audio/opus', 'application/json', 'text/html', 'video/mp4'])(
    'refuses %s',
    (mediaType) => {
      expect(isPlayableMusicMediaType(mediaType)).toBe(false);
    }
  );

  it('offers an extension for every playable type', () => {
    expect(MUSIC_FILE_EXTENSIONS['audio/mpeg']).toBe('mp3');
    expect(MUSIC_FILE_EXTENSIONS['audio/wav']).toBe('wav');
  });

  // The offered formats must all be ones the allowlist can actually play, or a visitor could choose
  // a format, pay for it, and be refused the result.
  it('offers only formats whose output this panel can play', () => {
    for (const model of modelsForTask('generate-music')) {
      for (const format of model.musicControls?.formats ?? []) {
        expect(format, `${model.id} offers ${format}`).toMatch(/^mp3|^wav$/u);
      }
    }
  });
});
