import { describe, expect, it } from 'vitest';
import {
  countTranslatableLines,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  predictInferenceCallCount,
  splitTranslationSegments,
  TRANSLATION_CONTROL_NAMES
} from '../../../src/shared/translate-text';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  buildTranslateTextInput,
  describeAppliedTranslationControls,
  validateTranslateTextRequest
} from '../../../src/worker/domain/translate-text';

/**
 * The reviewed translation models, in catalogue order.
 */
const [M2M100, INDIC] = modelsForTask('translate-text');

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
  return {
    text: 'The water is cold today.',
    model: M2M100!.id,
    runId: RUN_ID,
    targetLanguage: 'fr',
    ...overrides
  };
}

describe('the reviewed translation models', () => {
  it('registers two Cloudflare-hosted models', () => {
    const models = modelsForTask('translate-text');
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
    }
  });

  // The reason this panel needed no credit prerequisite, and the reason the phase brief preferred a
  // hosted dedicated translator over a third-party generalist.
  it('needs no third-party model, so the panel needs no prepaid credit', () => {
    expect(modelsForTask('translate-text').some((model) => model.provider === 'third-party')).toBe(
      false
    );
  });

  it('defaults to a Cloudflare-hosted model whose declared task is translation', () => {
    expect(M2M100?.provider).toBe('workers-ai');
    expect(M2M100?.id).toBe('@cf/meta/m2m100-1.2b');
  });

  // The decision recorded in the descriptor comments: a text-generation model would mean prompting
  // rather than passing validated language codes, which is the opposite of this panel's lesson.
  it('does not register the text-generation candidate', () => {
    expect(modelsForTask('translate-text').some((model) => model.id.includes('eurollm'))).toBe(
      false
    );
  });

  // The finding that shapes the whole panel: one model has no source language at all.
  it('declares a source control for one model and a fixed source for the other', () => {
    expect(M2M100?.translationControls?.sourceParameterName).toBe('source_lang');
    expect(M2M100?.translationControls?.fixedSourceLanguage).toBeUndefined();

    expect(INDIC?.translationControls?.sourceParameterName).toBeUndefined();
    expect(INDIC?.translationControls?.fixedSourceLanguage?.code).toBe('eng_Latn');
  });

  // The cost-shape disagreement, which is what makes this panel's disclosure necessary.
  it('declares different batching behaviour, and so different costs per passage', () => {
    expect(M2M100?.translationControls?.batchesSegments).toBe(false);
    expect(INDIC?.translationControls?.batchesSegments).toBe(true);
  });

  it('declares the target field under each model\u2019s own spelling', () => {
    expect(M2M100?.translationControls?.targetParameterName).toBe('target_lang');
    expect(INDIC?.translationControls?.targetParameterName).toBe('target_language');
  });

  it('declares each model\u2019s own output field', () => {
    expect(M2M100?.translationControls?.outputField).toBe('translated_text');
    expect(INDIC?.translationControls?.outputField).toBe('translations');
  });

  // Two standards for the same languages, which is why the lists are per model rather than merged.
  it('declares language codes in each model\u2019s own standard', () => {
    const m2m = M2M100?.translationControls?.targetLanguages.map((l) => l.code) ?? [];
    const indic = INDIC?.translationControls?.targetLanguages.map((l) => l.code) ?? [];

    expect(m2m).toContain('hi');
    expect(indic).toContain('hin_Deva');
    // Neither model accepts the other's spelling of the same language.
    expect(m2m).not.toContain('hin_Deva');
    expect(indic).not.toContain('hi');
  });

  // English is the fixed *source* for IndicTrans2, so offering it as a target would be offering an
  // English-to-English translation.
  it('does not offer the fixed source language as a target', () => {
    expect(INDIC?.translationControls?.targetLanguages.map((l) => l.code)).not.toContain(
      'eng_Latn'
    );
  });

  // A selector showing "Manipuri" twice would be unusable, and the codes name a script precisely so
  // that both can be offered.
  it('gives every language a distinct display name', () => {
    for (const model of modelsForTask('translate-text')) {
      const names = model.translationControls?.targetLanguages.map((l) => l.name) ?? [];
      expect(new Set(names).size, `${model.id} has distinct names`).toBe(names.length);
    }
  });

  it('declares a default target language that is in its own list', () => {
    for (const model of modelsForTask('translate-text')) {
      const controls = model.translationControls;
      expect(
        controls?.targetLanguages.some((l) => l.code === controls.defaultTargetLanguage),
        `${model.id} default target is declared`
      ).toBe(true);
    }
  });

  it('declares a default source language that is in its own list, where it has one', () => {
    const controls = M2M100?.translationControls;
    expect(controls?.sourceLanguages?.some((l) => l.code === controls.defaultSourceLanguage)).toBe(
      true
    );
  });

  // A default pair that cannot be submitted would make the panel refuse its own initial state.
  it('does not default to the same language on both sides', () => {
    for (const model of modelsForTask('translate-text')) {
      const controls = model.translationControls;
      const source = controls?.defaultSourceLanguage ?? controls?.fixedSourceLanguage?.code;
      expect(controls?.defaultTargetLanguage, `${model.id} defaults differ`).not.toBe(source);
    }
  });
});

describe('validating a request', () => {
  it('accepts a minimal request and resolves the model', () => {
    const request = validateTranslateTextRequest(body());

    expect(request.model.id).toBe(M2M100!.id);
    expect(request.runId).toBe(RUN_ID);
    expect(request.targetLanguage).toBe('fr');
  });

  it('rejects a body that is not an object', () => {
    expect(() => validateTranslateTextRequest('nope')).toThrow();
    expect(() => validateTranslateTextRequest([])).toThrow();
    expect(() => validateTranslateTextRequest(null)).toThrow();
  });

  it('rejects a malformed run identifier', () => {
    expect(() => validateTranslateTextRequest(body({ runId: 'short' }))).toThrow();
    expect(() => validateTranslateTextRequest(body({ runId: 'has spaces' }))).toThrow();
  });

  it('rejects a model belonging to another panel', () => {
    expect(() => validateTranslateTextRequest(body({ model: '@cf/deepgram/aura-2-en' }))).toThrow();
  });

  it('rejects an unknown model', () => {
    expect(() => validateTranslateTextRequest(body({ model: '@cf/not/a-model' }))).toThrow();
  });

  // The attribution rule. The actor comes from the verified Access JWT alone, so a body carrying
  // one of these is refused rather than quietly corrected.
  it('rejects a body carrying an identity field', () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(
        () => validateTranslateTextRequest(body({ [field]: 'mallory@example.com' })),
        field
      ).toThrow();
    }
  });

  it('rejects absent, non-string, or blank text', () => {
    expect(() => validateTranslateTextRequest(body({ text: undefined }))).toThrow();
    expect(() => validateTranslateTextRequest(body({ text: 42 }))).toThrow();
    expect(() => validateTranslateTextRequest(body({ text: '   ' }))).toThrow();
  });

  it('rejects text beyond the character limit', () => {
    const long = 'a'.repeat(MAX_TRANSLATION_CHARACTERS + 1);
    expect(() => validateTranslateTextRequest(body({ text: long }))).toThrow(/character limit/u);
  });

  // Counted in code points, which matters more here than in any earlier panel: the target
  // languages are written in scripts well outside the BMP.
  it('counts an astral character once rather than twice', () => {
    const astral = '\u{1F600}'.repeat(MAX_TRANSLATION_CHARACTERS);
    expect(() => validateTranslateTextRequest(body({ text: astral }))).not.toThrow();
  });

  it('rejects an absent or non-string target language', () => {
    expect(() => validateTranslateTextRequest(body({ targetLanguage: undefined }))).toThrow();
    expect(() => validateTranslateTextRequest(body({ targetLanguage: 7 }))).toThrow();
  });
});

describe('the per-model language contract', () => {
  it('accepts a language the selected model publishes', () => {
    expect(validateTranslateTextRequest(body({ targetLanguage: 'de' })).targetLanguage).toBe('de');
  });

  // The clearest demonstration that a language code is a per-model contract: the same language,
  // spelled each model's way, is accepted by exactly one of them.
  it('rejects the other model\u2019s spelling of the same language', () => {
    expect(() => validateTranslateTextRequest(body({ targetLanguage: 'hin_Deva' }))).toThrow();

    expect(() =>
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hi' }))
    ).toThrow();
  });

  it('accepts each model\u2019s own spelling', () => {
    expect(() => validateTranslateTextRequest(body({ targetLanguage: 'hi' }))).not.toThrow();
    expect(() =>
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hin_Deva' }))
    ).not.toThrow();
  });

  it('compares a language code exactly, without normalising case', () => {
    expect(() => validateTranslateTextRequest(body({ targetLanguage: 'FR' }))).toThrow();
  });

  it('accepts a source language the model publishes', () => {
    expect(validateTranslateTextRequest(body({ sourceLanguage: 'de' })).sourceLanguage).toBe('de');
  });

  it('rejects a source language outside the published list', () => {
    expect(() => validateTranslateTextRequest(body({ sourceLanguage: 'xx' }))).toThrow();
  });

  // Not merely out of range — the field does not exist in its schema at all, so the refusal
  // explains that rather than listing acceptable values.
  it('rejects a source language on the model that has no source field', () => {
    expect(() =>
      validateTranslateTextRequest(
        body({ model: INDIC!.id, targetLanguage: 'hin_Deva', sourceLanguage: 'eng_Latn' })
      )
    ).toThrow(/no source-language field/u);
  });

  it('names the fixed source language in that refusal', () => {
    expect(() =>
      validateTranslateTextRequest(
        body({ model: INDIC!.id, targetLanguage: 'hin_Deva', sourceLanguage: 'en' })
      )
    ).toThrow(/English/u);
  });

  // Nothing to translate, and a paid call that would return the input.
  it('rejects the same language on both sides', () => {
    expect(() =>
      validateTranslateTextRequest(body({ sourceLanguage: 'fr', targetLanguage: 'fr' }))
    ).toThrow(/nothing to translate/u);
  });

  // The default source counts for this check too, so the common case of leaving the source alone
  // and choosing English as the target is still refused.
  it('rejects a target matching the model\u2019s default source', () => {
    expect(() => validateTranslateTextRequest(body({ targetLanguage: 'en' }))).toThrow(
      /nothing to translate/u
    );
  });

  // Asking a fixed-source model to translate English into English is as pointless as asking the
  // other, even though there is no control the visitor could have set wrongly.
  it('rejects a target matching a fixed source language', () => {
    expect(() =>
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'eng_Latn' }))
    ).toThrow();
  });

  // A guard on the control list: a control added to the contract without validation would pass
  // every other test in this file while being forwarded unchecked.
  it('validates or rejects every named control', () => {
    const values: Record<string, unknown> = {
      sourceLanguage: 'not-a-language',
      targetLanguage: 'not-a-language'
    };

    for (const control of TRANSLATION_CONTROL_NAMES) {
      expect(
        () => validateTranslateTextRequest(body({ [control]: values[control] })),
        control
      ).toThrow();
    }
  });
});

describe('segmenting the source text', () => {
  it('splits on line boundaries', () => {
    const request = validateTranslateTextRequest(body({ text: 'one\ntwo\nthree' }));

    expect(request.lines).toEqual(['one', 'two', 'three']);
    expect(request.contentLineIndices).toEqual([0, 1, 2]);
  });

  // Text pasted from a Windows editor would otherwise be one enormous line, which would defeat the
  // line preservation this panel promises.
  it('normalises CRLF and lone CR to LF', () => {
    expect(validateTranslateTextRequest(body({ text: 'one\r\ntwo' })).lines).toEqual([
      'one',
      'two'
    ]);
    expect(validateTranslateTextRequest(body({ text: 'one\rtwo' })).lines).toEqual(['one', 'two']);
  });

  // Blank lines are structure rather than content: they keep their position and cost nothing.
  it('keeps a blank line but does not send it', () => {
    const request = validateTranslateTextRequest(body({ text: 'one\n\nthree' }));

    expect(request.lines).toEqual(['one', '', 'three']);
    expect(request.contentLineIndices).toEqual([0, 2]);
  });

  it('treats a whitespace-only line as blank', () => {
    const request = validateTranslateTextRequest(body({ text: 'one\n   \nthree' }));
    expect(request.contentLineIndices).toEqual([0, 2]);
  });

  // The cost bound. A character limit alone would let a pasted list of short lines become a large
  // number of paid calls from one click.
  it('rejects more translatable lines than the segment limit', () => {
    const many = Array.from({ length: MAX_TRANSLATION_SEGMENTS + 1 }, (_u, i) => `line ${i}`).join(
      '\n'
    );

    expect(() => validateTranslateTextRequest(body({ text: many }))).toThrow(/lines rather than/u);
  });

  it('accepts exactly the segment limit', () => {
    const atLimit = Array.from({ length: MAX_TRANSLATION_SEGMENTS }, (_u, i) => `line ${i}`).join(
      '\n'
    );

    expect(() => validateTranslateTextRequest(body({ text: atLimit }))).not.toThrow();
  });

  // Blank lines must not consume the segment budget, since they are never sent.
  it('does not count blank lines against the segment limit', () => {
    const padded = Array.from({ length: MAX_TRANSLATION_SEGMENTS }, (_u, i) => `line ${i}`).join(
      '\n\n'
    );

    expect(() => validateTranslateTextRequest(body({ text: padded }))).not.toThrow();
  });
});

describe('building the model input', () => {
  it('sends a bare string to the model that takes one', () => {
    const input = buildTranslateTextInput(validateTranslateTextRequest(body()), ['a line']);

    expect(input['text']).toBe('a line');
    expect(Array.isArray(input['text'])).toBe(false);
  });

  // A model declaring `string | string[]` returns one translation per input, so the array form is
  // what makes a whole passage a single call.
  it('sends an array to the model that batches', () => {
    const input = buildTranslateTextInput(
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hin_Deva' })),
      ['one', 'two']
    );

    expect(input['text']).toEqual(['one', 'two']);
  });

  it('writes the target language under the model\u2019s own field name', () => {
    expect(buildTranslateTextInput(validateTranslateTextRequest(body()), ['x'])).toMatchObject({
      target_lang: 'fr'
    });

    expect(
      buildTranslateTextInput(
        validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hin_Deva' })),
        ['x']
      )
    ).toMatchObject({ target_language: 'hin_Deva' });
  });

  it('sends a chosen source language', () => {
    expect(
      buildTranslateTextInput(validateTranslateTextRequest(body({ sourceLanguage: 'de' })), ['x'])
    ).toMatchObject({ source_lang: 'de' });
  });

  // Filled in rather than omitted, so the applied controls this panel reports are what was sent
  // rather than a guess about the provider's default.
  it('fills in the model\u2019s default source language', () => {
    expect(buildTranslateTextInput(validateTranslateTextRequest(body()), ['x'])).toMatchObject({
      source_lang: 'en'
    });
  });

  // Nothing a model did not declare reaches the provider, and there is no field to put it in.
  it('sends no source field at all to the fixed-source model', () => {
    const input = buildTranslateTextInput(
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hin_Deva' })),
      ['x']
    );

    expect(input).not.toHaveProperty('source_lang');
    expect(input).not.toHaveProperty('source_language');
    expect(Object.keys(input).sort()).toEqual(['target_language', 'text']);
  });

  it('never forwards the run identifier or the model name', () => {
    const input = buildTranslateTextInput(validateTranslateTextRequest(body()), ['x']);

    expect(input).not.toHaveProperty('runId');
    expect(input).not.toHaveProperty('model');
  });
});

describe('describing the applied controls', () => {
  it('reports the model, the languages, and the call count', () => {
    const applied = describeAppliedTranslationControls(
      validateTranslateTextRequest(body({ sourceLanguage: 'de' })),
      3
    );

    expect(applied).toMatchObject({
      model: M2M100!.id,
      sourceLanguage: 'de',
      targetLanguage: 'fr',
      inferenceCallCount: 3
    });
  });

  // Always present, because a translation with an unstated source language is not interpretable.
  it('reports the default source language when none was chosen', () => {
    expect(
      describeAppliedTranslationControls(validateTranslateTextRequest(body()), 1).sourceLanguage
    ).toBe('en');
  });

  it('reports a fixed-source model\u2019s own language', () => {
    const applied = describeAppliedTranslationControls(
      validateTranslateTextRequest(body({ model: INDIC!.id, targetLanguage: 'hin_Deva' })),
      1
    );

    expect(applied.sourceLanguage).toBe('eng_Latn');
  });

  // The browser already has the text, and returning it would put the visitor's content in one more
  // place for no benefit.
  it('reports a character count without echoing the text', () => {
    const applied = describeAppliedTranslationControls(
      validateTranslateTextRequest(body({ text: 'something private' })),
      1
    );

    expect(applied.characterCount).toBe(17);
    expect(JSON.stringify(applied)).not.toContain('something private');
  });
});

describe('the shared helpers', () => {
  it('splits text the same way the server does', () => {
    expect(splitTranslationSegments('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts only translatable lines', () => {
    expect(countTranslatableLines('one\n\ntwo')).toBe(2);
    expect(countTranslatableLines('   \n\t')).toBe(0);
    expect(countTranslatableLines('')).toBe(0);
  });

  // The figure the panel quotes before the request. Shared so the browser's prediction and the
  // server's actual count cannot drift.
  it('predicts one call for a batching model and one per line otherwise', () => {
    const text = 'one\ntwo\nthree';

    expect(predictInferenceCallCount(text, true)).toBe(1);
    expect(predictInferenceCallCount(text, false)).toBe(3);
  });

  it('predicts no calls for text with nothing to translate', () => {
    expect(predictInferenceCallCount('   ', true)).toBe(0);
    expect(predictInferenceCallCount('', false)).toBe(0);
  });

  it('ignores blank lines when predicting', () => {
    expect(predictInferenceCallCount('one\n\n\ntwo', false)).toBe(2);
  });
});
