import { describe, expect, it } from 'vitest';
import {
  estimateSpeechCostUsd,
  isSpeechFormatName,
  MAX_SPEECH_CHARACTERS,
  SPEECH_CONTROL_NAMES
} from '../../../src/shared/read-text';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  buildReadTextInput,
  describeAppliedSpeechControls,
  validateReadTextRequest
} from '../../../src/worker/domain/read-text';

/**
 * The reviewed speech models, in catalogue order.
 */
const [AURA_2, AURA_1, MELO] = modelsForTask('read-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * Builds a request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { text: 'Hello there.', model: AURA_2!.id, runId: RUN_ID, ...overrides };
}

describe('the reviewed speech models', () => {
  it('registers three Cloudflare-hosted models', () => {
    const models = modelsForTask('read-text');
    expect(models).toHaveLength(3);
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
    }
  });

  // The whole reason phase 9 delivers this panel rather than Animate Image. A third-party model
  // would reintroduce the prepaid-credit prerequisite that blocks the deferred phases.
  it('needs no third-party model, so the panel needs no prepaid credit', () => {
    expect(modelsForTask('read-text').some((model) => model.provider === 'third-party')).toBe(
      false
    );
  });

  it('defaults to a Cloudflare-hosted model', () => {
    expect(AURA_2?.provider).toBe('workers-ai');
  });

  it('gives every model reviewed speech controls', () => {
    for (const model of modelsForTask('read-text')) {
      expect(model.speechControls, `${model.id} declares controls`).toBeDefined();
    }
  });

  // The finding that shapes the whole panel. The two families share no control at all, so a single
  // hardcoded form could not drive both — which is what makes the per-model declaration do visible
  // work rather than being decorative.
  it('declares mutually exclusive voice and language controls', () => {
    expect(AURA_2?.speechControls?.voices).toBeDefined();
    expect(AURA_2?.speechControls?.languages).toBeUndefined();

    expect(MELO?.speechControls?.languages).toBeDefined();
    expect(MELO?.speechControls?.voices).toBeUndefined();
  });

  // Not cosmetic: a provider validating its own schema rejects the other spelling, so the wire name
  // has to travel with the descriptor.
  it('records the differing wire name of the text field', () => {
    expect(AURA_2?.speechControls?.textParameterName).toBe('text');
    expect(MELO?.speechControls?.textParameterName).toBe('prompt');
  });

  // The two Aura generations overlap only partially, which is why the panel resets a voice on model
  // change rather than carrying it over.
  it('gives the two Aura generations different voice lists', () => {
    const second = AURA_2?.speechControls?.voices ?? [];
    const first = AURA_1?.speechControls?.voices ?? [];

    expect(first).not.toEqual(second);
    expect(second).toContain('amalthea');
    expect(second).not.toContain('angus');
    expect(first).toContain('angus');
  });

  it('declares each model default inside its own published list', () => {
    for (const model of modelsForTask('read-text')) {
      const controls = model.speechControls;
      if (controls?.voices !== undefined) {
        expect(controls.voices, `${model.id} default voice`).toContain(controls.defaultVoice);
      }
      if (controls?.languages !== undefined) {
        expect(controls.languages, `${model.id} default language`).toContain(
          controls.defaultLanguage
        );
      }
      if (controls?.formats !== undefined) {
        expect(controls.formats, `${model.id} default format`).toContain(controls.defaultFormat);
      }
    }
  });

  // A format default without a format list would describe a choice the panel does not offer, and
  // the applied controls would then report a format the visitor could not have selected.
  it('declares a format default only alongside a format list', () => {
    for (const model of modelsForTask('read-text')) {
      const controls = model.speechControls;
      if (controls?.formats === undefined) {
        expect(
          controls?.defaultFormat,
          `${model.id} declares no orphan format default`
        ).toBeUndefined();
      }
    }
  });

  // The reviewed answer to the phase brief's "rate and pitch when supported": none of them support
  // either. Pinned so a later descriptor cannot claim support without a contract to back it.
  it('declares no rate or pitch control, because no reviewed model has one', () => {
    for (const model of modelsForTask('read-text')) {
      expect(model.speechControls?.rate, `${model.id} rate`).toBeUndefined();
      expect(model.speechControls?.pitch, `${model.id} pitch`).toBeUndefined();
    }
  });
});

describe('validating a request', () => {
  it('accepts a minimal request and resolves the model', () => {
    const request = validateReadTextRequest(body());
    expect(request.text).toBe('Hello there.');
    expect(request.model.id).toBe(AURA_2!.id);
    expect(request.runId).toBe(RUN_ID);
  });

  it('trims the text', () => {
    expect(validateReadTextRequest(body({ text: '  spoken  ' })).text).toBe('spoken');
  });

  it('rejects a body that is not an object', () => {
    expect(() => validateReadTextRequest('nope')).toThrow();
    expect(() => validateReadTextRequest([])).toThrow();
    expect(() => validateReadTextRequest(null)).toThrow();
  });

  it('rejects absent, empty, and whitespace-only text', () => {
    expect(() => validateReadTextRequest(body({ text: undefined }))).toThrow();
    expect(() => validateReadTextRequest(body({ text: '' }))).toThrow();
    expect(() => validateReadTextRequest(body({ text: '   ' }))).toThrow();
  });

  it('rejects text beyond the character limit', () => {
    expect(() =>
      validateReadTextRequest(body({ text: 'a'.repeat(MAX_SPEECH_CHARACTERS + 1) }))
    ).toThrow();
  });

  it('accepts text exactly at the limit', () => {
    expect(() =>
      validateReadTextRequest(body({ text: 'a'.repeat(MAX_SPEECH_CHARACTERS) }))
    ).not.toThrow();
  });

  // Counted in code points rather than UTF-16 units, so a non-BMP character counts once. A limit
  // that disagreed with the editor's own counter would refuse a passage the UI said was fine.
  it('counts a non-BMP character once', () => {
    const emoji = '\u{1F600}'.repeat(MAX_SPEECH_CHARACTERS);
    expect(() => validateReadTextRequest(body({ text: emoji }))).not.toThrow();
    expect(() => validateReadTextRequest(body({ text: `${emoji}\u{1F600}` }))).toThrow();
  });

  it('rejects a malformed run identifier', () => {
    expect(() => validateReadTextRequest(body({ runId: 'short' }))).toThrow();
    expect(() => validateReadTextRequest(body({ runId: 'has spaces in it' }))).toThrow();
  });

  it('rejects a model belonging to another panel', () => {
    expect(() =>
      validateReadTextRequest(body({ model: '@cf/black-forest-labs/flux-1-schnell' }))
    ).toThrow();
  });

  it('rejects an unknown model', () => {
    expect(() => validateReadTextRequest(body({ model: '@cf/not/a-model' }))).toThrow();
  });

  // The attribution rule. The actor comes from the verified Access JWT alone, so a body carrying
  // one of these is refused rather than quietly corrected.
  it('rejects a body carrying an identity field', () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(
        () => validateReadTextRequest(body({ [field]: 'mallory@example.com' })),
        field
      ).toThrow();
    }
  });
});

describe('validating controls against the selected model', () => {
  it('accepts a voice the model publishes', () => {
    expect(validateReadTextRequest(body({ voice: 'orion' })).voice).toBe('orion');
  });

  it('rejects a voice the model does not publish', () => {
    expect(() => validateReadTextRequest(body({ voice: 'angus' }))).toThrow();
  });

  // The sharpest consequence of the per-model declaration: the same value is valid for one reviewed
  // model and invalid for another in the same family.
  it('accepts on Aura 1 a voice that Aura 2 rejects', () => {
    expect(() => validateReadTextRequest(body({ voice: 'angus' }))).toThrow();
    expect(validateReadTextRequest(body({ model: AURA_1!.id, voice: 'angus' })).voice).toBe(
      'angus'
    );
  });

  // Not merely out of range — the field does not exist in the schema. Naming the model in the
  // refusal is what tells a caller which model to switch to.
  it('rejects a language on a model with no language control', () => {
    expect(() => validateReadTextRequest(body({ language: 'en' }))).toThrow(/Aura 2/u);
  });

  it('rejects a voice on a model with no voice control', () => {
    expect(() => validateReadTextRequest(body({ model: MELO!.id, voice: 'luna' }))).toThrow(
      /MeloTTS/u
    );
  });

  it('accepts a language the multilingual model publishes', () => {
    expect(validateReadTextRequest(body({ model: MELO!.id, language: 'fr' })).language).toBe('fr');
  });

  it('rejects a language outside the published list', () => {
    expect(() => validateReadTextRequest(body({ model: MELO!.id, language: 'xx' }))).toThrow();
  });

  // Compared exactly rather than case-insensitively. A provider validating against an enum treats
  // these as different strings, so normalising here would move the failure from this clear message
  // to an opaque `502` from the provider.
  it('compares a control value exactly, without normalising case', () => {
    expect(() => validateReadTextRequest(body({ voice: 'Luna' }))).toThrow();
  });

  it('rejects a non-string control value', () => {
    expect(() => validateReadTextRequest(body({ voice: 7 }))).toThrow();
  });

  it('accepts a format the model offers', () => {
    expect(validateReadTextRequest(body({ format: 'wav' })).format).toBe('wav');
  });

  it('rejects a format the model does not offer', () => {
    expect(() => validateReadTextRequest(body({ format: 'flac' }))).toThrow();
  });

  it('rejects any format on a model that offers no choice', () => {
    expect(() => validateReadTextRequest(body({ model: MELO!.id, format: 'mp3' }))).toThrow();
  });

  // Rejected rather than silently dropped, for every reviewed model. Dropping would teach a visitor
  // that the control did nothing, when the truth is that no reviewed model has it.
  it('rejects rate and pitch on every reviewed model', () => {
    for (const model of modelsForTask('read-text')) {
      expect(
        () => validateReadTextRequest(body({ model: model.id, rate: 1.2 })),
        model.id
      ).toThrow();
      expect(
        () => validateReadTextRequest(body({ model: model.id, pitch: 0.8 })),
        model.id
      ).toThrow();
    }
  });

  // A guard on the control list: a control added to the contract without validation would pass
  // every other test in this file while being forwarded unchecked.
  it('validates or rejects every named control', () => {
    const values: Record<string, unknown> = {
      voice: 'not-a-voice',
      language: 'not-a-language',
      format: 'not-a-format',
      rate: 99,
      pitch: 99
    };

    for (const control of SPEECH_CONTROL_NAMES) {
      expect(
        () => validateReadTextRequest(body({ [control]: values[control] })),
        control
      ).toThrow();
    }
  });
});

describe('building the model input', () => {
  it('uses each model\u2019s own name for the text field', () => {
    expect(buildReadTextInput(validateReadTextRequest(body()))).toMatchObject({
      text: 'Hello there.'
    });
    expect(buildReadTextInput(validateReadTextRequest(body({ model: MELO!.id })))).toMatchObject({
      prompt: 'Hello there.'
    });
  });

  it('never sends the other family\u2019s text field name', () => {
    expect(buildReadTextInput(validateReadTextRequest(body()))).not.toHaveProperty('prompt');
    expect(
      buildReadTextInput(validateReadTextRequest(body({ model: MELO!.id })))
    ).not.toHaveProperty('text');
  });

  it('sends a chosen voice as the provider\u2019s speaker field', () => {
    expect(buildReadTextInput(validateReadTextRequest(body({ voice: 'zeus' })))).toMatchObject({
      speaker: 'zeus'
    });
  });

  // The default is sent explicitly rather than omitted, so the voice the panel reports as applied is
  // one the provider was actually asked for rather than one this demo believes it would have chosen.
  it('sends the model default when no voice was chosen', () => {
    expect(buildReadTextInput(validateReadTextRequest(body()))).toMatchObject({ speaker: 'luna' });
  });

  it('sends a chosen language as the provider\u2019s lang field', () => {
    expect(
      buildReadTextInput(validateReadTextRequest(body({ model: MELO!.id, language: 'jp' })))
    ).toMatchObject({ lang: 'jp' });
  });

  it('sends no speaker to a model that has no speaker parameter', () => {
    expect(
      buildReadTextInput(validateReadTextRequest(body({ model: MELO!.id })))
    ).not.toHaveProperty('speaker');
  });

  it('sends no language to a model that has no language parameter', () => {
    expect(buildReadTextInput(validateReadTextRequest(body()))).not.toHaveProperty('lang');
  });

  // The indirection this demo's single format name exists for. Aura spells an output choice as an
  // encoding plus a container, and the legal pairings live in its prose rather than its schema; a
  // visitor assembling the two separately could produce a request the provider accepts and the
  // browser cannot play.
  it('expands the wav format into the provider\u2019s encoding and container pair', () => {
    expect(buildReadTextInput(validateReadTextRequest(body({ format: 'wav' })))).toMatchObject({
      encoding: 'linear16',
      container: 'wav'
    });
  });

  it('sends mp3 as an encoding with no container', () => {
    const input = buildReadTextInput(validateReadTextRequest(body({ format: 'mp3' })));
    expect(input).toMatchObject({ encoding: 'mp3' });
    expect(input).not.toHaveProperty('container');
  });

  // Nothing a model did not declare reaches the provider. This is the assertion that would catch a
  // control forwarded to a schema that never agreed to accept it.
  it('sends only the fields each model declares', () => {
    expect(Object.keys(buildReadTextInput(validateReadTextRequest(body())))).toEqual([
      'text',
      'speaker',
      'encoding'
    ]);
    expect(
      Object.keys(buildReadTextInput(validateReadTextRequest(body({ model: MELO!.id }))))
    ).toEqual(['prompt', 'lang']);
  });

  it('never forwards the run identifier or the model name', () => {
    const input = buildReadTextInput(validateReadTextRequest(body()));
    expect(input).not.toHaveProperty('runId');
    expect(input).not.toHaveProperty('model');
  });
});

describe('describing the applied controls', () => {
  it('fills in the model defaults the caller omitted', () => {
    const applied = describeAppliedSpeechControls(validateReadTextRequest(body()));
    expect(applied).toMatchObject({
      model: AURA_2!.id,
      voice: 'luna',
      format: 'mp3',
      characterCount: 12
    });
  });

  it('reports a caller\u2019s own choices', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ voice: 'hera', format: 'wav' }))
    );
    expect(applied).toMatchObject({ voice: 'hera', format: 'wav' });
  });

  it('omits a control the model does not support', () => {
    const applied = describeAppliedSpeechControls(validateReadTextRequest(body()));
    expect(applied.language).toBeUndefined();
  });

  it('reports a language for the multilingual model and no voice', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ model: MELO!.id }))
    );
    expect(applied.language).toBe('en');
    expect(applied.voice).toBeUndefined();
  });

  it('estimates the cost for a character-priced model', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ text: 'a'.repeat(1_000) }))
    );
    expect(applied.estimatedCostUsd).toBeCloseTo(0.03, 6);
  });

  it('halves the estimate on the cheaper Aura generation', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ model: AURA_1!.id, text: 'a'.repeat(1_000) }))
    );
    expect(applied.estimatedCostUsd).toBeCloseTo(0.015, 6);
  });

  // Absent rather than zero. The billable quantity for a minute-priced model does not exist until
  // the audio has been generated, and a zero would read as "free" — the one thing a cost figure
  // must never do.
  it('omits the estimate for a model billed per minute of audio', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ model: MELO!.id }))
    );
    expect(applied.estimatedCostUsd).toBeUndefined();
    expect(applied).not.toHaveProperty('estimatedCostUsd');
  });

  // The visitor's text is never echoed back. The browser already has it, and returning it would put
  // the content in one more place for no benefit.
  it('reports the character count rather than the text', () => {
    const applied = describeAppliedSpeechControls(
      validateReadTextRequest(body({ text: 'something private' }))
    );
    expect(JSON.stringify(applied)).not.toContain('something private');
    expect(applied.characterCount).toBe(17);
  });
});

describe('the shared cost estimate', () => {
  it('scales linearly with the character count', () => {
    expect(estimateSpeechCostUsd(2_000, 0.03)).toBeCloseTo(0.06, 6);
    expect(estimateSpeechCostUsd(500, 0.03)).toBeCloseTo(0.015, 6);
  });

  it('is zero for empty text rather than undefined', () => {
    expect(estimateSpeechCostUsd(0, 0.03)).toBe(0);
  });

  // Absence is a meaningful answer: it means "this cannot be estimated", which the panel renders as
  // a sentence rather than as a number.
  it('is absent when the model does not bill by character', () => {
    expect(estimateSpeechCostUsd(1_000, undefined)).toBeUndefined();
  });
});

describe('the format-name predicate', () => {
  it('accepts the reviewed format names', () => {
    expect(isSpeechFormatName('mp3')).toBe(true);
    expect(isSpeechFormatName('wav')).toBe(true);
  });

  it('refuses a provider encoding this demo does not offer', () => {
    expect(isSpeechFormatName('linear16')).toBe(false);
    expect(isSpeechFormatName('flac')).toBe(false);
  });
});
