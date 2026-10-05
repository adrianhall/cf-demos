import { describe, expect, it } from 'vitest';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  TEXT_CLASSIFICATION_CONTROL_NAMES
} from '../../../src/shared/classify-text';
import {
  buildClassifyTextInput,
  describeAppliedTextClassificationControls,
  findReviewedLabelName,
  rankTextClassificationLabels,
  validateClassifyTextRequest
} from '../../../src/worker/domain/classify-text';
import { modelsForTask } from '../../../src/worker/domain/models';

/**
 * The reviewed text classifiers, in catalogue order.
 */
const [DISTILBERT, LLAMA_GUARD] = modelsForTask('classify-text');

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
    text: 'The staff were wonderful and the food arrived quickly.',
    model: DISTILBERT!.id,
    runId: RUN_ID,
    ...overrides
  };
}

describe('the reviewed classification models', () => {
  it('registers two Cloudflare-hosted models', () => {
    const models = modelsForTask('classify-text');
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
    }
  });

  it('needs no third-party model, so the panel needs no prepaid credit', () => {
    expect(modelsForTask('classify-text').some((model) => model.provider === 'third-party')).toBe(
      false
    );
  });

  it('defaults to the genuine fixed-label sentiment classifier', () => {
    expect(DISTILBERT?.id).toBe('@cf/huggingface/distilbert-sst-2-int8');
    expect(DISTILBERT?.textClassificationControls?.outcomeKind).toBe('scored-labels');
  });

  // The exclusion the phase brief asked to be justified. The reranker scores relevance between a
  // query and the caller's own passages, which is the opposite of a fixed label set.
  it('does not register the reranker', () => {
    expect(modelsForTask('classify-text').some((model) => model.id.includes('reranker'))).toBe(
      false
    );
  });

  // The finding that shapes the whole panel: one model scores its labels, the other scores
  // nothing at all.
  it('declares different outcome kinds, so the result cannot assume a score', () => {
    expect(DISTILBERT?.textClassificationControls?.outcomeKind).toBe('scored-labels');
    expect(LLAMA_GUARD?.textClassificationControls?.outcomeKind).toBe('verdict');
  });

  // A verdict model has no score, so ranking controls would be meaningless on it.
  it('declares ranking controls only for the scoring model', () => {
    expect(DISTILBERT?.textClassificationControls?.topK).toBeDefined();
    expect(DISTILBERT?.textClassificationControls?.minimumConfidence).toBeDefined();

    expect(LLAMA_GUARD?.textClassificationControls?.topK).toBeUndefined();
    expect(LLAMA_GUARD?.textClassificationControls?.minimumConfidence).toBeUndefined();
  });

  it('declares each model\u2019s own request shape', () => {
    expect(DISTILBERT?.textClassificationControls?.inputShape).toBe('text');
    // A chat model underneath, which is also why its declared task type is Text Generation.
    expect(LLAMA_GUARD?.textClassificationControls?.inputShape).toBe('messages');
  });

  // Neither model has a ranking field in its schema, so this demo does the filtering and says so.
  it('records that the controls are applied by this application', () => {
    for (const model of modelsForTask('classify-text')) {
      expect(model.textClassificationControls?.appliedBy, model.id).toBe('playground');
    }
  });

  // The panel's central teaching device: the complete, closed set of possible answers.
  it('publishes a complete label set for every model', () => {
    for (const model of modelsForTask('classify-text')) {
      const labels = model.textClassificationControls?.labelSet ?? [];
      expect(labels.length, `${model.id} publishes labels`).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.code, `${model.id} label has a code`).toBeTruthy();
        expect(label.name, `${model.id} label has a name`).toBeTruthy();
      }
    }
  });

  it('names what each label set is, so a result stays interpretable', () => {
    expect(DISTILBERT?.textClassificationControls?.labelSetName).toMatch(/sentiment/iu);
    expect(LLAMA_GUARD?.textClassificationControls?.labelSetName).toMatch(/hazard|safety/iu);
  });

  it('publishes exactly the two SST-2 sentiment labels', () => {
    const codes = DISTILBERT?.textClassificationControls?.labelSet.map((l) => l.code) ?? [];
    expect(codes).toEqual(['POSITIVE', 'NEGATIVE']);
  });

  // Names come from Cloudflare's published Guardrails table; the *range* comes from the model's
  // own output schema, which describes the field as "from S1 to S14".
  it('publishes the full S1\u2013S14 hazard taxonomy', () => {
    const codes = LLAMA_GUARD?.textClassificationControls?.labelSet.map((l) => l.code) ?? [];
    expect(codes).toHaveLength(14);
    expect(codes[0]).toBe('S1');
    expect(codes.at(-1)).toBe('S14');
    expect(LLAMA_GUARD?.textClassificationControls?.labelSet[9]?.name).toBe('Hate');
  });

  // The Guardrails table stops at S13 because it documents what *Guardrails* evaluates, saying so
  // explicitly. This panel calls the model directly, so the model's own range applies — and a
  // visitor who sees S14 in a result deserves its published name rather than a bare code.
  it('includes the category Guardrails does not evaluate', () => {
    const labels = LLAMA_GUARD?.textClassificationControls?.labelSet ?? [];
    expect(labels.find((label) => label.code === 'S14')?.name).toBe('Code Interpreter Abuse');
  });

  it('gives every label a distinct code', () => {
    for (const model of modelsForTask('classify-text')) {
      const codes = model.textClassificationControls?.labelSet.map((l) => l.code) ?? [];
      expect(new Set(codes).size, `${model.id} codes are distinct`).toBe(codes.length);
    }
  });

  // The hazard disclosed in the contract: a model that truncates returns a confident score for a
  // prefix, with nothing in the response saying so.
  it('declares a context window, and the panel limit stays inside the smallest', () => {
    const windows = modelsForTask('classify-text').map(
      (model) => model.textClassificationControls?.contextWindowTokens ?? 0
    );
    for (const window of windows) {
      expect(window).toBeGreaterThan(0);
    }

    // A conservative four characters per token against the smallest window.
    const smallest = Math.min(...windows);
    expect(MAX_CLASSIFICATION_TEXT_CHARACTERS).toBeLessThanOrEqual(smallest * 4);
  });
});

describe('validating a request', () => {
  it('accepts a minimal request and resolves the model', () => {
    const request = validateClassifyTextRequest(body());

    expect(request.model.id).toBe(DISTILBERT!.id);
    expect(request.runId).toBe(RUN_ID);
  });

  it('rejects a body that is not an object', () => {
    expect(() => validateClassifyTextRequest('nope')).toThrow();
    expect(() => validateClassifyTextRequest([])).toThrow();
    expect(() => validateClassifyTextRequest(null)).toThrow();
  });

  it('rejects a malformed run identifier', () => {
    expect(() => validateClassifyTextRequest(body({ runId: 'short' }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ runId: 'has spaces' }))).toThrow();
  });

  it('rejects a model belonging to another panel', () => {
    expect(() => validateClassifyTextRequest(body({ model: '@cf/meta/m2m100-1.2b' }))).toThrow();
  });

  it('rejects an unknown model', () => {
    expect(() => validateClassifyTextRequest(body({ model: '@cf/not/a-model' }))).toThrow();
  });

  it('rejects a body carrying an identity field', () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(
        () => validateClassifyTextRequest(body({ [field]: 'mallory@example.com' })),
        field
      ).toThrow();
    }
  });

  it('rejects absent, non-string, or blank text', () => {
    expect(() => validateClassifyTextRequest(body({ text: undefined }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ text: 42 }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ text: '   ' }))).toThrow();
  });

  it('rejects text beyond the character limit', () => {
    const long = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS + 1);
    expect(() => validateClassifyTextRequest(body({ text: long }))).toThrow(/character/u);
  });

  // The refusal explains the context window, because otherwise the limit looks arbitrary next to
  // the other text panels' larger ceilings.
  it('explains that the limit protects against silent truncation', () => {
    const long = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS + 1);
    expect(() => validateClassifyTextRequest(body({ text: long }))).toThrow(/context window/u);
  });

  it('counts an astral character once rather than twice', () => {
    const astral = '\u{1F600}'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS);
    expect(() => validateClassifyTextRequest(body({ text: astral }))).not.toThrow();
  });
});

/**
 * The regression guard the phase brief asks for by name.
 *
 * This panel is fixed-label classification: the categories belong to the trained model. An API that
 * appeared to accept caller-defined criteria would be teaching the opposite of what the panel
 * exists to show, so the body is refused rather than having the field stripped.
 */
describe('rejecting caller-defined criteria', () => {
  it('rejects a caller-supplied label set under any plausible spelling', () => {
    const attempts: Record<string, unknown> = {
      labels: ['urgent', 'not urgent'],
      label: 'urgent',
      categories: ['billing', 'technical'],
      category: 'billing',
      classes: ['a', 'b'],
      candidateLabels: ['spam', 'ham'],
      candidate_labels: ['spam', 'ham'],
      criteria: 'is this urgent?',
      question: 'is this urgent?',
      questions: [{ kind: 'noul', text: 'is this urgent?' }],
      choices: ['yes', 'no'],
      taxonomy: 'my-own-taxonomy',
      hypothesis: 'This text is about billing.'
    };

    for (const [field, value] of Object.entries(attempts)) {
      expect(() => validateClassifyTextRequest(body({ [field]: value })), field).toThrow();
    }
  });

  // Refused, not stripped. Someone sending `labels` has a real need and would otherwise believe
  // their categories were applied and that the model chose none of them.
  it('refuses rather than silently dropping the field', () => {
    expect(() => validateClassifyTextRequest(body({ labels: ['urgent', 'not urgent'] }))).toThrow(
      /cannot be supplied by the caller/u
    );
  });

  // The refusal points at the panel that does take caller-defined questions, because the request
  // is reasonable — it has simply arrived at the wrong endpoint.
  it('names Evaluate Choices as the task that takes caller-defined questions', () => {
    expect(() => validateClassifyTextRequest(body({ question: 'is this urgent?' }))).toThrow(
      /Evaluate Choices/u
    );
  });

  it('refuses even when the rest of the request is valid', () => {
    expect(() => validateClassifyTextRequest(body({ topK: 1, categories: ['mine'] }))).toThrow();
  });

  // The contract itself must offer no such field, so there is nothing for a caller to populate in
  // the first place. Asserted against the request type's own keys.
  it('has no field in the validated request through which labels could travel', () => {
    const request = validateClassifyTextRequest(body({ topK: 2, minimumConfidence: 0.1 }));

    expect(Object.keys(request).sort()).toEqual([
      'minimumConfidence',
      'model',
      'runId',
      'text',
      'topK'
    ]);
  });
});

describe('the per-model control contract', () => {
  it('accepts controls within the scoring model\u2019s declared range', () => {
    const request = validateClassifyTextRequest(body({ topK: 1, minimumConfidence: 0.5 }));

    expect(request.topK).toBe(1);
    expect(request.minimumConfidence).toBe(0.5);
  });

  it('rejects a control outside the declared range', () => {
    expect(() => validateClassifyTextRequest(body({ topK: 0 }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ topK: 99 }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ minimumConfidence: -0.1 }))).toThrow();
    expect(() => validateClassifyTextRequest(body({ minimumConfidence: 1.5 }))).toThrow();
  });

  it('rejects a non-finite control value', () => {
    expect(() => validateClassifyTextRequest(body({ topK: Number.NaN }))).toThrow();
    expect(() =>
      validateClassifyTextRequest(body({ minimumConfidence: Number.POSITIVE_INFINITY }))
    ).toThrow();
    expect(() => validateClassifyTextRequest(body({ topK: '2' }))).toThrow();
  });

  // Not merely out of range — there is no score in this model's output for either control to act
  // on, so the refusal explains that rather than listing acceptable values.
  it('rejects a ranking control on the model that reports no scores', () => {
    expect(() => validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id, topK: 2 }))).toThrow(
      /nothing to rank or filter/u
    );

    expect(() =>
      validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id, minimumConfidence: 0.5 }))
    ).toThrow(/nothing to rank or filter/u);
  });

  it('names the model in that refusal', () => {
    expect(() => validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id, topK: 2 }))).toThrow(
      /Llama Guard/u
    );
  });

  it('accepts the verdict model with no controls at all', () => {
    const request = validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id }));

    expect(request.topK).toBeUndefined();
    expect(request.minimumConfidence).toBeUndefined();
  });

  // A guard on the control list: a control added to the contract without validation would pass
  // every other test in this file while being forwarded unchecked.
  it('validates or rejects every named control', () => {
    for (const control of TEXT_CLASSIFICATION_CONTROL_NAMES) {
      expect(
        () => validateClassifyTextRequest(body({ [control]: 'not-a-number' })),
        control
      ).toThrow();
    }
  });
});

describe('building the model input', () => {
  it('sends a plain text field to the conventional classifier', () => {
    const input = buildClassifyTextInput(validateClassifyTextRequest(body({ text: 'hello' })));

    expect(input).toEqual({ text: 'hello' });
  });

  // A chat model underneath, so the text travels as a single user message.
  it('sends a messages array to the chat-shaped model', () => {
    const input = buildClassifyTextInput(
      validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id, text: 'hello' }))
    );

    expect(input['messages']).toEqual([{ role: 'user', content: 'hello' }]);
  });

  /**
   * The regression test for the bug that made this model unusable on first delivery.
   *
   * Its output schema declares `response` as `string | { safe, categories }` without saying what
   * selects between them, and the default is the string: asked plainly it answers "\n\nsafe".
   * Without `response_format` every run of this model failed, because the application correctly
   * refuses to parse a safety verdict out of prose.
   */
  it('asks the safety model for a structured response', () => {
    const input = buildClassifyTextInput(
      validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id }))
    );

    expect(input['response_format']).toEqual({ type: 'json_object' });
  });

  // Declared per model rather than applied to every chat-shaped model, because sending a field a
  // model does not declare is the kind of silent incompatibility this panel is about.
  it('does not send a response format to a model that does not declare one', () => {
    const input = buildClassifyTextInput(validateClassifyTextRequest(body()));

    expect(input).not.toHaveProperty('response_format');
  });

  // A model needing a structured response format cannot be registered without the flag, or it
  // would fail on every run exactly as this one did.
  it('declares the response-format requirement for every verdict model', () => {
    for (const model of modelsForTask('classify-text')) {
      const controls = model.textClassificationControls;
      if (controls?.outcomeKind === 'verdict') {
        expect(controls.requiresJsonResponseFormat, `${model.id} asks for JSON`).toBe(true);
      }
    }
  });

  // Adding an instruction would be the caller-defined criteria this panel refuses, smuggled in by
  // the application instead of the caller. Llama Guard applies its own taxonomy.
  it('sends no system prompt or instruction with the text', () => {
    const input = buildClassifyTextInput(
      validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id }))
    );
    const messages = input['messages'] as { role: string }[];

    expect(messages).toHaveLength(1);
    expect(messages.every((message) => message.role === 'user')).toBe(true);
  });

  // Neither model has a ranking field in its schema, so forwarding one would be sending a property
  // the provider never declared.
  it('never forwards the ranking controls to the provider', () => {
    const input = buildClassifyTextInput(
      validateClassifyTextRequest(body({ topK: 1, minimumConfidence: 0.5 }))
    );

    expect(Object.keys(input)).toEqual(['text']);
  });

  it('never forwards the run identifier or the model name', () => {
    const input = buildClassifyTextInput(validateClassifyTextRequest(body()));

    expect(input).not.toHaveProperty('runId');
    expect(input).not.toHaveProperty('model');
  });
});

describe('ranking the labels', () => {
  /**
   * A validated request against the scoring model.
   *
   * @param overrides Body fields to replace.
   * @returns The validated request.
   */
  function scored(overrides: Record<string, unknown> = {}) {
    return validateClassifyTextRequest(body(overrides));
  }

  it('orders by score, highest first, and assigns ranks', () => {
    const ranked = rankTextClassificationLabels(
      [
        { label: 'NEGATIVE', score: 0.2 },
        { label: 'POSITIVE', score: 0.8 }
      ],
      scored()
    );

    expect(ranked.map((entry) => [entry.rank, entry.label])).toEqual([
      [1, 'POSITIVE'],
      [2, 'NEGATIVE']
    ]);
  });

  it('names each label from the reviewed set', () => {
    const ranked = rankTextClassificationLabels([{ label: 'POSITIVE', score: 0.9 }], scored());

    expect(ranked[0]?.name).toBe('Positive');
  });

  // A model emitting an unexpected code must not be able to put arbitrary text on the page, so the
  // name comes from the reviewed set and an unknown code shows as itself.
  it('falls back to the raw code for a label outside the reviewed set', () => {
    const ranked = rankTextClassificationLabels([{ label: 'NEUTRAL', score: 0.9 }], scored());

    expect(ranked[0]?.name).toBe('NEUTRAL');
  });

  it('applies the confidence floor', () => {
    const ranked = rankTextClassificationLabels(
      [
        { label: 'POSITIVE', score: 0.9 },
        { label: 'NEGATIVE', score: 0.1 }
      ],
      scored({ minimumConfidence: 0.5 })
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.label).toBe('POSITIVE');
  });

  it('truncates to the requested count', () => {
    const ranked = rankTextClassificationLabels(
      [
        { label: 'POSITIVE', score: 0.6 },
        { label: 'NEGATIVE', score: 0.4 }
      ],
      scored({ topK: 1 })
    );

    expect(ranked).toHaveLength(1);
  });

  // Not hypothetical for a binary classifier given neutral text, and a non-deterministic order
  // would make the panel's own output unstable between runs.
  it('breaks a score tie deterministically by label name', () => {
    const ranked = rankTextClassificationLabels(
      [
        { label: 'POSITIVE', score: 0.5 },
        { label: 'NEGATIVE', score: 0.5 }
      ],
      scored()
    );

    expect(ranked.map((entry) => entry.label)).toEqual(['NEGATIVE', 'POSITIVE']);
  });

  // A set of scores that no longer sums to 1 is the honest consequence of hiding some; adjusting
  // them to compensate would be inventing output the model did not produce.
  it('never rescales the scores after filtering', () => {
    const ranked = rankTextClassificationLabels(
      [
        { label: 'POSITIVE', score: 0.7 },
        { label: 'NEGATIVE', score: 0.3 }
      ],
      scored({ topK: 1 })
    );

    expect(ranked[0]?.score).toBe(0.7);
  });

  it('reports full-precision scores rather than rounding', () => {
    const ranked = rankTextClassificationLabels(
      [{ label: 'POSITIVE', score: 0.123_456_789 }],
      scored()
    );

    expect(ranked[0]?.score).toBe(0.123_456_789);
  });

  // An empty result from a floor nobody reached is a real outcome of a successful run.
  it('returns nothing when every label is below the floor', () => {
    const ranked = rankTextClassificationLabels(
      [{ label: 'POSITIVE', score: 0.2 }],
      scored({ minimumConfidence: 0.9 })
    );

    expect(ranked).toEqual([]);
  });
});

describe('naming a reviewed label', () => {
  it('finds the published name for a declared code', () => {
    expect(findReviewedLabelName(LLAMA_GUARD!, 'S10')).toBe('Hate');
  });

  it('returns the code itself for an undeclared one', () => {
    expect(findReviewedLabelName(LLAMA_GUARD!, 'S99')).toBe('S99');
  });

  // Matched exactly rather than case-insensitively, so a change in the model's own spelling
  // surfaces as unrecognised instead of being quietly absorbed.
  it('matches a code exactly, without normalising case', () => {
    expect(findReviewedLabelName(DISTILBERT!, 'positive')).toBe('positive');
    expect(findReviewedLabelName(DISTILBERT!, 'POSITIVE')).toBe('Positive');
  });
});

describe('describing the applied controls', () => {
  it('reports the model and the label set name', () => {
    const applied = describeAppliedTextClassificationControls(validateClassifyTextRequest(body()));

    expect(applied.model).toBe(DISTILBERT!.id);
    expect(applied.labelSetName).toBe('Sentiment (SST-2)');
  });

  it('fills in the model defaults for controls the caller omitted', () => {
    const applied = describeAppliedTextClassificationControls(validateClassifyTextRequest(body()));

    expect(applied.topK).toBe(DISTILBERT!.textClassificationControls!.topK!.default);
    expect(applied.minimumConfidence).toBe(0);
  });

  it('reports the caller\u2019s own values when set', () => {
    const applied = describeAppliedTextClassificationControls(
      validateClassifyTextRequest(body({ topK: 1, minimumConfidence: 0.25 }))
    );

    expect(applied.topK).toBe(1);
    expect(applied.minimumConfidence).toBe(0.25);
  });

  // Absent rather than zero: reporting a floor of 0 for a model with no such control would imply
  // the control exists and was left at its default.
  it('omits controls the model does not have', () => {
    const applied = describeAppliedTextClassificationControls(
      validateClassifyTextRequest(body({ model: LLAMA_GUARD!.id }))
    );

    expect(applied).not.toHaveProperty('topK');
    expect(applied).not.toHaveProperty('minimumConfidence');
    expect(applied.labelSetName).toBe('Llama Guard 3 hazard taxonomy');
  });

  // The browser already has the text, and returning it would put the visitor's content in one more
  // place for no benefit.
  it('reports a character count without echoing the text', () => {
    const applied = describeAppliedTextClassificationControls(
      validateClassifyTextRequest(body({ text: 'something private' }))
    );

    expect(applied.characterCount).toBe(17);
    expect(JSON.stringify(applied)).not.toContain('something private');
  });
});
