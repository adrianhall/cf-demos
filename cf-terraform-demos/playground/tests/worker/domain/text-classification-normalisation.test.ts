/**
 * @file Tests for reading a classification out of each reviewed model's response shape. The two
 *   paths have very different failure modes: the scored path is about structural validation of a
 *   collection, and the verdict path is about refusing to guess at a safety decision.
 */

import { describe, expect, it } from 'vitest';
import { validateClassifyTextRequest } from '../../../src/worker/domain/classify-text';
import { modelsForTask } from '../../../src/worker/domain/models';
import { readTextClassification } from '../../../src/worker/domain/text-classification-normalisation';

/**
 * The reviewed text classifiers, in catalogue order.
 */
const [DISTILBERT, LLAMA_GUARD, CLEF_FLASH] = modelsForTask('classify-text');

/**
 * Builds a validated request against the scoring model.
 *
 * @param overrides Body fields to replace.
 * @returns The validated request.
 */
function scoredRequest(overrides: Record<string, unknown> = {}) {
  return validateClassifyTextRequest({
    text: 'The staff were wonderful.',
    model: DISTILBERT!.id,
    runId: 'a1b2c3d4-1111-4222-8333-444455556666',
    ...overrides
  });
}

/**
 * Builds a validated request against the reviewed Clef sentiment mode.
 *
 * @returns The validated request.
 */
function clefRequest() {
  return validateClassifyTextRequest({
    text: 'The staff were wonderful.',
    model: CLEF_FLASH!.id,
    runId: 'a1b2c3d4-1111-4222-8333-444455556666'
  });
}

/**
 * Builds a validated request against the verdict model.
 *
 * @returns The validated request.
 */
function verdictRequest() {
  return validateClassifyTextRequest({
    text: 'How do I prune a tomato plant?',
    model: LLAMA_GUARD!.id,
    runId: 'a1b2c3d4-1111-4222-8333-444455556666'
  });
}

describe('the scored-label response', () => {
  it('reads a ranked list from the provider array', () => {
    const read = readTextClassification(
      [
        { label: 'NEGATIVE', score: 0.02 },
        { label: 'POSITIVE', score: 0.98 }
      ],
      scoredRequest()
    );

    expect(read.ok).toBe(true);
    if (!read.ok || read.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }

    expect(read.outcome.labels[0]).toMatchObject({ rank: 1, label: 'POSITIVE', name: 'Positive' });
    expect(read.outcome.totalLabels).toBe(2);
  });

  // The schema declares a bare array at the top level, which is unusual enough to assert: most
  // models in this demo wrap their answer in an object.
  it('refuses an object where its contract declares an array', () => {
    expect(readTextClassification({ labels: [] }, scoredRequest())).toEqual({
      ok: false,
      reason: 'unrecognised_shape'
    });
  });

  it('refuses a non-array, non-object response', () => {
    expect(readTextClassification('POSITIVE', scoredRequest()).ok).toBe(false);
    expect(readTextClassification(null, scoredRequest()).ok).toBe(false);
  });

  // One bad element out of several is a provider quirk worth skipping, not a reason to fail a run
  // that produced usable output.
  it('skips an unusable element but keeps the rest', () => {
    const read = readTextClassification(
      [{ label: 'POSITIVE', score: 0.9 }, 'not an object', { label: 'NEGATIVE', score: 0.1 }],
      scoredRequest()
    );

    expect(read.ok).toBe(true);
    if (!read.ok || read.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }

    expect(read.outcome.labels).toHaveLength(2);
    expect(read.diagnostics).toEqual({ returned: 3, skipped: 1 });
  });

  it('skips an element with a missing or blank label', () => {
    const read = readTextClassification(
      [{ score: 0.9 }, { label: '  ', score: 0.8 }, { label: 'POSITIVE', score: 0.7 }],
      scoredRequest()
    );

    expect(read.ok && read.diagnostics?.skipped).toBe(2);
  });

  // `NaN` and `Infinity` are both numbers and both would paint a bar.
  it('skips a non-finite score', () => {
    const read = readTextClassification(
      [
        { label: 'A', score: Number.NaN },
        { label: 'B', score: Number.POSITIVE_INFINITY },
        { label: 'POSITIVE', score: 0.5 }
      ],
      scoredRequest()
    );

    expect(read.ok && read.diagnostics?.skipped).toBe(2);
  });

  // Rejected rather than clamped: clamping would present an impossible value as a plausible one.
  it('skips a score outside the range a probability can occupy', () => {
    const read = readTextClassification(
      [
        { label: 'A', score: 7 },
        { label: 'B', score: -0.5 },
        { label: 'POSITIVE', score: 0.5 }
      ],
      scoredRequest()
    );

    expect(read.ok && read.diagnostics?.skipped).toBe(2);
  });

  it('skips a non-numeric score', () => {
    const read = readTextClassification(
      [
        { label: 'A', score: '0.9' },
        { label: 'POSITIVE', score: 0.5 }
      ],
      scoredRequest()
    );

    expect(read.ok && read.diagnostics?.skipped).toBe(1);
  });

  // Every element bad is a contract change worth refusing, unlike one element bad.
  it('refuses when nothing usable survives', () => {
    expect(readTextClassification([{ nonsense: true }, 'bad'], scoredRequest())).toEqual({
      ok: false,
      reason: 'no_usable_labels'
    });
  });

  it('refuses an empty array', () => {
    expect(readTextClassification([], scoredRequest())).toEqual({
      ok: false,
      reason: 'no_usable_labels'
    });
  });

  it('applies the request\u2019s ranking controls', () => {
    const read = readTextClassification(
      [
        { label: 'POSITIVE', score: 0.9 },
        { label: 'NEGATIVE', score: 0.1 }
      ],
      scoredRequest({ minimumConfidence: 0.5 })
    );

    expect(read.ok && read.outcome.kind === 'scored-labels' && read.outcome.labels).toHaveLength(1);
  });

  // The count before filtering, so the panel can say "showing 1 of the 2 labels this model
  // returned" rather than implying the model was asked for one.
  it('reports the pre-filter count so the panel can describe what was hidden', () => {
    const read = readTextClassification(
      [
        { label: 'POSITIVE', score: 0.9 },
        { label: 'NEGATIVE', score: 0.1 }
      ],
      scoredRequest({ topK: 1 })
    );

    expect(read.ok && read.outcome.kind === 'scored-labels' && read.outcome.totalLabels).toBe(2);
  });
});

describe('the reviewed Clef choice response', () => {
  it('turns the immutable sentiment choice probabilities into ranked labels', () => {
    const read = readTextClassification(
      {
        model: 'clef-flash',
        answers: {
          sentiment: {
            type: 'choice',
            choice: 'POSITIVE',
            probabilities: { POSITIVE: 0.9734, NEGATIVE: 0.026, NEUTRAL: 0.0006 },
            confidence: 0.8963
          }
        },
        usage: { input_tokens: 151, output_tokens: 0 }
      },
      clefRequest()
    );

    expect(read.ok).toBe(true);
    if (!read.ok || read.outcome.kind !== 'scored-labels') {
      throw new Error('expected scored labels');
    }

    expect(read.outcome.labels.map((label) => [label.label, label.score])).toEqual([
      ['POSITIVE', 0.9734],
      ['NEGATIVE', 0.026],
      ['NEUTRAL', 0.0006]
    ]);
    expect(read.outcome.totalLabels).toBe(3);
  });

  // The model may include other answer fields for Evaluate Choices. This panel reads exactly the
  // reviewed immutable `sentiment` key rather than discovering an arbitrary answer.
  it('refuses when the reviewed sentiment answer is absent', () => {
    expect(
      readTextClassification(
        { answers: { topic: { type: 'choice', probabilities: {} } } },
        clefRequest()
      )
    ).toEqual({ ok: false, reason: 'unrecognised_shape' });
  });

  it('refuses an arbitrary probability key instead of rendering it as a label', () => {
    const read = readTextClassification(
      { answers: { sentiment: { type: 'choice', probabilities: { CALLER_DEFINED: 1 } } } },
      clefRequest()
    );

    expect(read).toEqual({ ok: false, reason: 'no_usable_labels' });
  });
});

describe('the verdict response', () => {
  it('reads a safe verdict', () => {
    const read = readTextClassification(
      { response: { safe: true, categories: [] } },
      verdictRequest()
    );

    expect(read.ok).toBe(true);
    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.safe).toBe(true);
    expect(read.outcome.verdict.categories).toEqual([]);
  });

  it('names the cited categories from the reviewed taxonomy', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S1', 'S10'] } },
      verdictRequest()
    );

    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.safe).toBe(false);
    expect(read.outcome.verdict.categories.map((c) => c.name)).toEqual(['Violent Crimes', 'Hate']);
  });

  // The model emits bare codes, so a result without this mapping would read as "S1" with no
  // indication of what it means.
  it('carries the published code alongside the name', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S10'] } },
      verdictRequest()
    );

    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.categories[0]).toMatchObject({ code: 'S10', name: 'Hate' });
  });

  // A code outside the published set means the taxonomy has moved again. Surfaced rather than
  // dropped, and deliberately without an invented name. `S99` rather than `S14`, because S14 is a
  // real category this panel now names.
  it('reports an unrecognised category as unrecognised rather than naming it', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S1', 'S99'] } },
      verdictRequest()
    );

    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.categories.map((c) => c.code)).toEqual(['S1']);
    expect(read.outcome.verdict.unrecognisedCategories).toEqual(['S99']);
  });

  // The category Guardrails does not evaluate but the model can still emit. It must be named,
  // not reported as unknown.
  it('names the category outside the Guardrails subset', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S14'] } },
      verdictRequest()
    );

    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.categories[0]?.name).toBe('Code Interpreter Abuse');
    expect(read.outcome.verdict.unrecognisedCategories).toEqual([]);
  });

  it('ignores a non-string entry in the categories array', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S1', 42, null] } },
      verdictRequest()
    );

    if (!read.ok || read.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }

    expect(read.outcome.verdict.categories).toHaveLength(1);
    expect(read.outcome.verdict.unrecognisedCategories).toEqual([]);
  });

  it('tolerates an absent categories array on a safe verdict', () => {
    const read = readTextClassification({ response: { safe: true } }, verdictRequest());

    expect(read.ok && read.outcome.kind === 'verdict' && read.outcome.verdict.safe).toBe(true);
  });

  /**
   * The most important refusal in the panel.
   *
   * The model's own output type declares `response` as `string | { safe, categories }`. A safety
   * verdict extracted from prose by pattern-matching would be a security control resting on a
   * regular expression, and a missed parse would report unsafe content as safe.
   */
  it('refuses a prose answer rather than parsing a safety decision out of it', () => {
    expect(readTextClassification({ response: 'safe' }, verdictRequest())).toEqual({
      ok: false,
      reason: 'prose_verdict'
    });
  });

  it('refuses prose even when it looks structured', () => {
    expect(readTextClassification({ response: 'unsafe\nS1,S10' }, verdictRequest())).toEqual({
      ok: false,
      reason: 'prose_verdict'
    });
  });

  // Defaulting to `true` would announce unverified content as safe; defaulting to `false` would
  // accuse it on the strength of a malformed response. Neither is acceptable, so it refuses.
  it('refuses a verdict with no safe boolean rather than defaulting either way', () => {
    expect(readTextClassification({ response: { categories: ['S1'] } }, verdictRequest())).toEqual({
      ok: false,
      reason: 'missing_verdict'
    });
  });

  it('refuses a non-boolean safe field', () => {
    expect(readTextClassification({ response: { safe: 'yes' } }, verdictRequest())).toEqual({
      ok: false,
      reason: 'missing_verdict'
    });
  });

  it('refuses a response that is not an object', () => {
    const unrecognised = { ok: false, reason: 'unrecognised_shape' };

    expect(readTextClassification('safe', verdictRequest())).toEqual(unrecognised);
    expect(readTextClassification(null, verdictRequest())).toEqual(unrecognised);
    expect(readTextClassification([], verdictRequest())).toEqual(unrecognised);
  });

  it('refuses an envelope with no response field', () => {
    expect(readTextClassification({ usage: {} }, verdictRequest())).toEqual({
      ok: false,
      reason: 'unrecognised_shape'
    });
  });

  // The verdict carries no score anywhere, and the panel must not be able to invent one.
  it('produces no score field for a verdict outcome', () => {
    const read = readTextClassification(
      { response: { safe: false, categories: ['S1'] } },
      verdictRequest()
    );

    expect(JSON.stringify(read)).not.toContain('score');
  });
});

describe('choosing the shape from the reviewed descriptor', () => {
  // The shape is read from the model's declaration rather than probed for, so a model answering in
  // the other model's shape is a diagnosable refusal rather than a quiet mismatch.
  it('refuses a scored array from the model declared to return a verdict', () => {
    expect(readTextClassification([{ label: 'POSITIVE', score: 0.9 }], verdictRequest()).ok).toBe(
      false
    );
  });

  it('refuses a verdict envelope from the model declared to return scores', () => {
    expect(readTextClassification({ response: { safe: true } }, scoredRequest()).ok).toBe(false);
  });
});
