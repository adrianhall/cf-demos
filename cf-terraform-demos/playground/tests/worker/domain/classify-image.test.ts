/**
 * @file Domain tests for Classify Image. Two things here are new to this panel and carry most of
 *   the weight. The first is that the reviewed model takes no ranking parameters, so the top-k and
 *   the confidence floor are applied to the response — which makes the ranking a domain rule with
 *   edge cases rather than a presentation detail. The second is that the request has no prompt at
 *   all, so the validation asserts on what is _refused_ as much as on what is accepted.
 */

import { describe, expect, it } from 'vitest';
import { MAX_CLASSIFICATION_LABELS } from '../../../src/shared/classify-image';
import {
  buildClassifyImageInput,
  describeAppliedClassificationControls,
  rankClassificationLabels,
  validateClassifyImageRequest,
  type ValidatedClassifyImageRequest
} from '../../../src/worker/domain/classify-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { pngBase64 } from '../support/image-fixtures';
import { thrownBy } from '../support/problem-details';

/**
 * Every reviewed classifier.
 */
const MODELS = modelsForTask('classify-image');

/**
 * The default classifier, which is also the only one the catalogue currently lists.
 */
const RESNET = MODELS[0]!;

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Builds a valid request body.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(120, 80),
    model: RESNET.id,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Builds a validated request, going through real validation rather than hand-building the type.
 *
 * @param overrides Body fields to replace or add.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}): ValidatedClassifyImageRequest {
  return validateClassifyImageRequest(body(overrides));
}

describe('the reviewed classifier', () => {
  it('is Cloudflare-hosted and billed per request rather than per token', () => {
    expect(RESNET.id).toBe('@cf/microsoft/resnet-50');
    expect(RESNET.provider).toBe('workers-ai');
    expect(RESNET.pricingUnit).toBe('provider-reported');
  });

  // The fact the whole panel is shaped around. If a model were ever added whose schema did accept
  // ranking fields, this assertion failing is the prompt to build the other branch rather than to
  // quietly keep filtering the response.
  it('declares that this application applies its result controls, not the model', () => {
    expect(RESNET.classificationControls?.appliedBy).toBe('playground');
  });

  it('declares both result controls with usable ranges', () => {
    expect(RESNET.classificationControls?.topK).toMatchObject({ min: 1, default: 5 });
    expect(RESNET.classificationControls?.minimumConfidence).toMatchObject({ min: 0, max: 1 });
  });

  // The upper bound of the control and the hard ceiling in the contract have to agree, or a
  // visitor could ask for more labels than the ranking will ever return and see the slider stop
  // having an effect.
  it('caps its top-k control at the contract ceiling', () => {
    expect(RESNET.classificationControls?.topK?.max).toBe(MAX_CLASSIFICATION_LABELS);
  });
});

describe('validateClassifyImageRequest', () => {
  it('verifies the picture from its bytes rather than from a declaration', () => {
    expect(request().source.facts).toMatchObject({
      mediaType: 'image/png',
      width: 120,
      height: 80
    });
  });

  it('accepts both controls within the model\u2019s declared ranges', () => {
    const validated = request({ topK: 3, minimumConfidence: 0.25 });
    expect(validated.topK).toBe(3);
    expect(validated.minimumConfidence).toBe(0.25);
  });

  it('leaves an omitted control unset rather than filling in a default', () => {
    const validated = request();
    expect(validated.topK).toBeUndefined();
    expect(validated.minimumConfidence).toBeUndefined();
  });

  it.each([
    ['a body that is not an object', 'not-an-object'],
    ['an array body', []],
    ['a null body', null]
  ])('rejects %s', (_label, candidate) => {
    expect(thrownBy(() => validateClassifyImageRequest(candidate))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  it.each(['user', 'email', 'actor', 'sub'])('rejects a body carrying "%s"', (field) => {
    expect(thrownBy(() => validateClassifyImageRequest(body({ [field]: 'x' })))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  it.each(['mediaType', 'contentType', 'mimeType', 'width', 'height', 'fileName'])(
    'rejects a body describing its own image with "%s"',
    (field) => {
      expect(thrownBy(() => validateClassifyImageRequest(body({ [field]: 'x' })))).toMatchObject({
        problemDetails: { status: 400 }
      });
    }
  );

  // A classifier has nothing to be asked. Refusing the field, rather than ignoring it, is what
  // tells a caller who sent `instruction` that they have misunderstood the panel.
  it.each(['instruction', 'prompt', 'question', 'negativePrompt'])(
    'rejects the generative field "%s" with an explanation',
    (field) => {
      const error = thrownBy(() => validateClassifyImageRequest(body({ [field]: 'what is this' })));
      expect(error).toMatchObject({ problemDetails: { status: 400 } });
      expect((error as { problemDetails: { detail: string } }).problemDetails.detail).toContain(
        'fixed label set'
      );
    }
  );

  it('rejects a malformed run identifier', () => {
    expect(thrownBy(() => validateClassifyImageRequest(body({ runId: 'x' })))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  // Resolved against this panel specifically, so a reviewed model from another panel cannot be
  // named here. Without this, the narrow task API becomes a generic `{ model, input }` proxy.
  it('rejects a model belonging to another panel', () => {
    expect(
      thrownBy(() =>
        validateClassifyImageRequest(body({ model: '@cf/black-forest-labs/flux-1-schnell' }))
      )
    ).toMatchObject({ problemDetails: { status: 400 } });
  });

  it.each([
    ['a non-numeric top-k', { topK: 'three' }],
    ['a fractional top-k', { topK: 2.5 }],
    ['a top-k below the range', { topK: 0 }],
    ['a top-k above the range', { topK: MAX_CLASSIFICATION_LABELS + 1 }],
    ['a confidence below the range', { minimumConfidence: -0.1 }],
    ['a confidence above the range', { minimumConfidence: 1.5 }],
    ['a non-numeric confidence', { minimumConfidence: 'high' }]
  ])('rejects %s', (_label, overrides) => {
    expect(thrownBy(() => validateClassifyImageRequest(body(overrides)))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  // A fractional floor is the whole point of that control, so the whole-number rule must apply to
  // top-k alone. Pinning it stops a later refactor applying one rule to both.
  it('accepts a fractional confidence floor while refusing a fractional top-k', () => {
    expect(request({ minimumConfidence: 0.125 }).minimumConfidence).toBe(0.125);
    expect(thrownBy(() => validateClassifyImageRequest(body({ topK: 3.5 })))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  // `NaN` and `Infinity` both serialise to `null` in JSON, so a value that survived validation
  // would reach the ranking step as a comparison that silently discards every label.
  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects %s as a confidence floor', (value) => {
    expect(
      thrownBy(() => validateClassifyImageRequest(body({ minimumConfidence: value })))
    ).toMatchObject({ problemDetails: { status: 400 } });
  });

  it.each([
    ['a payload that is not a picture', btoa('%PDF-1.7 not a picture')],
    ['SVG markup', btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an empty string', '']
  ])('rejects %s', (_label, imageBase64) => {
    expect(thrownBy(() => validateClassifyImageRequest(body({ imageBase64 })))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });

  it('rejects a picture beyond the pixel limit', () => {
    expect(
      thrownBy(() => validateClassifyImageRequest(body({ imageBase64: pngBase64(8_192, 64) })))
    ).toMatchObject({ problemDetails: { status: 400 } });
  });
});

describe('buildClassifyImageInput', () => {
  // The schema declares `image` and nothing else, so anything extra would be a field the provider
  // never agreed to accept.
  it('sends the picture as a byte array and nothing else', () => {
    const input = buildClassifyImageInput(request());
    expect(Object.keys(input)).toEqual(['image']);
    expect(Array.isArray(input['image'])).toBe(true);
  });

  // The controls are applied to the response, so forwarding them would be sending the model
  // parameters its schema does not declare — the single most common integration failure.
  it('never forwards the result controls to the model', () => {
    const input = buildClassifyImageInput(request({ topK: 2, minimumConfidence: 0.5 }));
    expect(input).not.toHaveProperty('topK');
    expect(input).not.toHaveProperty('top_k');
    expect(input).not.toHaveProperty('minimumConfidence');
    expect(input).not.toHaveProperty('threshold');
  });
});

describe('rankClassificationLabels', () => {
  /**
   * Labels in a deliberately unhelpful order, so a test cannot pass by accident.
   */
  const SCORED = [
    { label: 'tabby', score: 0.4 },
    { label: 'Egyptian cat', score: 0.52 },
    { label: 'lynx', score: 0.03 },
    { label: 'tiger cat', score: 0.41 },
    { label: 'paper towel', score: 0.001 }
  ];

  it('orders by descending score', () => {
    const ranked = rankClassificationLabels(SCORED, request({ topK: 5 }));
    expect(ranked.map((entry) => entry.label)).toEqual([
      'Egyptian cat',
      'tiger cat',
      'tabby',
      'lynx',
      'paper towel'
    ]);
  });

  it('numbers the ranks from one', () => {
    expect(rankClassificationLabels(SCORED, request({ topK: 3 })).map((e) => e.rank)).toEqual([
      1, 2, 3
    ]);
  });

  // A classifier returning two identical scores is ordinary. Without a tiebreak the same picture
  // would rank differently between runs, which looks like model behaviour and is not.
  it('breaks a score tie by label so the order is stable', () => {
    const tied = [
      { label: 'zebra', score: 0.5 },
      { label: 'alpaca', score: 0.5 }
    ];
    expect(rankClassificationLabels(tied, request()).map((entry) => entry.label)).toEqual([
      'alpaca',
      'zebra'
    ]);
  });

  it('keeps only the requested number of labels', () => {
    expect(rankClassificationLabels(SCORED, request({ topK: 2 }))).toHaveLength(2);
  });

  it('falls back to the model default when no top-k was requested', () => {
    expect(rankClassificationLabels(SCORED, request())).toHaveLength(
      RESNET.classificationControls!.topK!.default
    );
  });

  it('applies the confidence floor', () => {
    const ranked = rankClassificationLabels(SCORED, request({ minimumConfidence: 0.4 }));
    expect(ranked.map((entry) => entry.label)).toEqual(['Egyptian cat', 'tiger cat', 'tabby']);
  });

  // Inclusive, so a label scoring exactly the floor is shown. An exclusive comparison would make
  // a slider at 0.4 hide a label reading "40.0%", which reads as a bug.
  it('keeps a label scoring exactly the floor', () => {
    const ranked = rankClassificationLabels(
      [{ label: 'tabby', score: 0.4 }],
      request({ minimumConfidence: 0.4 })
    );
    expect(ranked).toHaveLength(1);
  });

  // The floor runs before the truncation, so "top 2 above 0.4" means the two best labels that
  // clear the floor rather than whatever survives the floor out of the best two.
  it('applies the floor before the limit', () => {
    const ranked = rankClassificationLabels(SCORED, request({ topK: 2, minimumConfidence: 0.41 }));
    expect(ranked.map((entry) => entry.label)).toEqual(['Egyptian cat', 'tiger cat']);
  });

  // An ordinary outcome of a successful run, not a failure: the model answered and the visitor
  // hid everything it said.
  it('returns an empty ranking when nothing clears the floor', () => {
    expect(rankClassificationLabels(SCORED, request({ minimumConfidence: 0.99 }))).toEqual([]);
  });

  // Nothing rescales after filtering. A set of scores that no longer sums to anything meaningful
  // is the honest consequence of hiding some; adjusting them would invent output.
  it('passes every surviving score through untouched', () => {
    const ranked = rankClassificationLabels(SCORED, request({ topK: 2 }));
    expect(ranked.map((entry) => entry.score)).toEqual([0.52, 0.41]);
  });

  it('never returns more than the contract ceiling', () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({
      label: `label-${index}`,
      score: index / 50
    }));
    expect(
      rankClassificationLabels(many, request({ topK: MAX_CLASSIFICATION_LABELS })).length
    ).toBeLessThanOrEqual(MAX_CLASSIFICATION_LABELS);
  });

  it('handles an empty provider list without throwing', () => {
    expect(rankClassificationLabels([], request())).toEqual([]);
  });
});

describe('describeAppliedClassificationControls', () => {
  it('reports the model and both controls the caller set', () => {
    expect(
      describeAppliedClassificationControls(request({ topK: 3, minimumConfidence: 0.2 }))
    ).toEqual({ model: RESNET.id, topK: 3, minimumConfidence: 0.2 });
  });

  // The panel reports what produced a result rather than only what was explicitly chosen, so a
  // visitor comparing two runs can see which settings differed.
  it('fills in the model defaults the caller omitted', () => {
    expect(describeAppliedClassificationControls(request())).toEqual({
      model: RESNET.id,
      topK: RESNET.classificationControls!.topK!.default,
      minimumConfidence: RESNET.classificationControls!.minimumConfidence!.default
    });
  });
});
