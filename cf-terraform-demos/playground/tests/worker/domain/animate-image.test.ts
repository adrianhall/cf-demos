/**
 * @file Tests for Animate Image validation, request building, and cost estimation. Three things get
 *   disproportionate attention here because they are what the phase is actually about. **Descriptor
 *   control compatibility.** The two registered models disagree about the source image's wire name,
 *   which resolutions exist, whether a prompt is required, which durations are legal, and how they
 *   price. Every one of those disagreements is asserted against _both_ models rather than against
 *   whichever happened to be convenient, because a validator that only ever sees the default model
 *   is a validator for one model. **The picture is never a caller-named location.** Every reviewed
 *   model types its image parameter as a URI, so the refusal to accept a URL from the caller is a
 *   security boundary rather than a style choice: a caller who could set it would be choosing a URL
 *   for a third party to fetch. **An unknown price is not a zero.** One model publishes prices for
 *   specific combinations and not others, so "no published price" has to survive estimation as a
 *   distinct answer.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ANIMATE_SOURCE_BYTES,
  MAX_MOTION_PROMPT_CHARACTERS,
  priceCombinationKey
} from '../../../src/shared/animate-image';
import {
  buildAnimateImageInput,
  describeAppliedAnimateControls,
  estimateAnimateCost,
  validateAnimateImageRequest
} from '../../../src/worker/domain/animate-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { pngBase64, toBase64 } from '../support/image-fixtures';

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * The default model: a duration range, an optional prompt, and a per-second price.
 */
const ALIBABA = 'alibaba/hh1.1-i2v';

/**
 * The comparison model: fixed durations, a required prompt, and per-combination prices.
 */
const MINIMAX = 'minimax/hailuo-2.3';

/**
 * Builds a valid request body for the default model.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(),
    model: ALIBABA,
    runId: RUN_ID,
    ...overrides
  };
}

describe('validateAnimateImageRequest', () => {
  it('accepts a picture with no motion prompt for a model that does not require one', () => {
    const request = validateAnimateImageRequest(body());

    expect(request.model.id).toBe(ALIBABA);
    expect(request.motionPrompt).toBeUndefined();
    // Defaults are resolved during validation rather than left to the request builder, so the
    // builder and the estimate work from one settled set of values.
    expect(request.resolution).toBe('720P');
    expect(request.duration).toBe(5);
  });

  it('refuses a request with no picture', () => {
    expect(() => validateAnimateImageRequest(body({ imageBase64: undefined }))).toThrow();
  });

  it('refuses a body that is not an object', () => {
    expect(() => validateAnimateImageRequest('nope')).toThrow(/must be a JSON object/u);
    expect(() => validateAnimateImageRequest([])).toThrow(/must be a JSON object/u);
    expect(() => validateAnimateImageRequest(null)).toThrow(/must be a JSON object/u);
  });

  it('refuses an implausible run identifier', () => {
    expect(() => validateAnimateImageRequest(body({ runId: 'nope' }))).toThrow(
      /valid run identifier/u
    );
  });

  it('refuses a model registered to another panel', () => {
    // A text-to-video model has nowhere to put a picture, so resolving against this panel's
    // registrations rather than the whole catalogue is what stops a wrongly shaped request.
    expect(() => validateAnimateImageRequest(body({ model: 'alibaba/hh1.1-t2v' }))).toThrow(
      /not a model this panel can use/u
    );
  });

  it.each(['user', 'email', 'actor', 'sub'])('refuses a body carrying %s', (field) => {
    expect(() => validateAnimateImageRequest(body({ [field]: 'x' }))).toThrow(/must not carry/u);
  });

  it.each(['jobId', 'instanceId', 'workflowId', 'videoKey'])(
    'refuses a body naming its own job with %s',
    (field) => {
      expect(() => validateAnimateImageRequest(body({ [field]: 'x' }))).toThrow(
        /derived from the verified identity/u
      );
    }
  );

  // The security boundary rather than tidiness: every reviewed model fetches its source image from
  // a URI, so a caller able to set that field would be choosing a URL for a third-party provider
  // to retrieve — including an internal one.
  it.each([
    'image',
    'imageUrl',
    'image_url',
    'imageUri',
    'image_uri',
    'first_frame_image',
    'image_input'
  ])('refuses a body naming the picture\u2019s location with %s', (field) => {
    expect(() =>
      validateAnimateImageRequest(body({ [field]: 'https://example.test/x.png' }))
    ).toThrow(/never fetches a picture from a location a caller named/u);
  });

  it('refuses a picture larger than the Workflow payload allowance', () => {
    // Deliberately built past this panel's own ceiling rather than past the shared image one: the
    // limit here exists because the picture has to survive a Workflow event parameter, and a
    // picture the shared rules accept can still be one no job could be started with.
    const oversized = toBase64(new Uint8Array(MAX_ANIMATE_SOURCE_BYTES + 1_024));

    expect(() => validateAnimateImageRequest(body({ imageBase64: oversized }))).toThrow();
  });

  it('refuses a motion prompt longer than the published limit', () => {
    const tooLong = 'a'.repeat(MAX_MOTION_PROMPT_CHARACTERS + 1);

    expect(() => validateAnimateImageRequest(body({ motionPrompt: tooLong }))).toThrow(
      /characters or fewer/u
    );
  });

  it('treats a whitespace-only motion prompt as absent rather than forwarding it', () => {
    // A provider is entitled to treat `""` as a meaningful value distinct from an omitted field.
    const request = validateAnimateImageRequest(body({ motionPrompt: '   ' }));

    expect(request.motionPrompt).toBeUndefined();
  });
});

describe('descriptor control compatibility', () => {
  it('requires a motion prompt only for the model whose schema demands one', () => {
    // MiniMax's validator rejects a request with no prompt; Alibaba's animates the picture
    // without one. The panel cannot pick one behaviour for both.
    expect(() =>
      validateAnimateImageRequest(body({ model: MINIMAX, resolution: '768P', duration: 6 }))
    ).toThrow(/requires a motion prompt/u);

    expect(() => validateAnimateImageRequest(body())).not.toThrow();
  });

  it('refuses each model\u2019s resolution when sent to the other', () => {
    // The two share no resolution value at all. Compared exactly rather than case-insensitively,
    // because a provider validating against an enum treats these as unrelated strings.
    expect(() => validateAnimateImageRequest(body({ resolution: '768P' }))).toThrow(
      /resolution must be one of 720P, 1080P/u
    );

    expect(() =>
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '720P', duration: 6 })
      )
    ).toThrow(/resolution must be one of 768P, 1080P/u);
  });

  it('applies a duration range for one model and a fixed set for the other', () => {
    // Alibaba: any integer in 3..15.
    expect(validateAnimateImageRequest(body({ duration: 12 })).duration).toBe(12);
    expect(() => validateAnimateImageRequest(body({ duration: 2 }))).toThrow(
      /between 3 and 15 seconds/u
    );
    expect(() => validateAnimateImageRequest(body({ duration: 16 }))).toThrow(
      /between 3 and 15 seconds/u
    );

    // MiniMax: exactly 6 or 10, verified one value at a time against the live validator. Eight is
    // inside the other model's range and is still refused here, which is the point.
    const minimax = (duration: number): Record<string, unknown> =>
      body({ model: MINIMAX, motionPrompt: 'drift', resolution: '768P', duration });

    expect(validateAnimateImageRequest(minimax(10)).duration).toBe(10);
    expect(() => validateAnimateImageRequest(minimax(8))).toThrow(/6 or 10 seconds/u);
  });

  it('refuses a fractional or non-numeric duration', () => {
    expect(() => validateAnimateImageRequest(body({ duration: 5.5 }))).toThrow(/whole number/u);
    expect(() => validateAnimateImageRequest(body({ duration: '5' }))).toThrow(/whole number/u);
  });

  it('accepts a seed only for the model that declares one', () => {
    expect(validateAnimateImageRequest(body({ seed: 42 })).seed).toBe(42);

    // MiniMax's schema declares no seed field, so sending one would be an undeclared property
    // rather than an ignored hint.
    expect(() =>
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '768P', duration: 6, seed: 42 })
      )
    ).toThrow(/does not accept seed/u);
  });

  it('refuses an out-of-range seed', () => {
    expect(() => validateAnimateImageRequest(body({ seed: -1 }))).toThrow(/whole number between/u);
    expect(() => validateAnimateImageRequest(body({ seed: 1.5 }))).toThrow(/whole number between/u);
  });

  it('accepts a negative prompt only for the model that declares one', () => {
    expect(validateAnimateImageRequest(body({ negativePrompt: 'blur' })).negativePrompt).toBe(
      'blur'
    );

    expect(() =>
      validateAnimateImageRequest(
        body({
          model: MINIMAX,
          motionPrompt: 'drift',
          resolution: '768P',
          duration: 6,
          negativePrompt: 'blur'
        })
      )
    ).toThrow(/does not accept negativePrompt/u);
  });
});

describe('buildAnimateImageInput', () => {
  it('names the source image as each model spells it', () => {
    // The phase's central disagreement, asserted directly. One concept, two wire names here and
    // four across the models that were probed.
    const alibaba = buildAnimateImageInput(validateAnimateImageRequest(body()));
    expect(Object.keys(alibaba)).toContain('image');
    expect(Object.keys(alibaba)).not.toContain('first_frame_image');

    const minimax = buildAnimateImageInput(
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '768P', duration: 6 })
      )
    );
    expect(Object.keys(minimax)).toContain('first_frame_image');
    expect(Object.keys(minimax)).not.toContain('image');
  });

  it('sends the picture as a data URI built from the sniffed media type', () => {
    const input = buildAnimateImageInput(validateAnimateImageRequest(body()));

    // The media type comes from the bytes' own header, never from anything the browser declared,
    // and the whole value is constructed here rather than accepted from the caller.
    expect(input['image']).toMatch(/^data:image\/png;base64,/u);
  });

  it('omits every control the caller did not set', () => {
    const input = buildAnimateImageInput(validateAnimateImageRequest(body()));

    // These schemas reject an undeclared field outright, so an unset control must be absent rather
    // than present and empty.
    expect(input).not.toHaveProperty('negative_prompt');
    expect(input).not.toHaveProperty('seed');
    expect(input).not.toHaveProperty('prompt');
  });

  it('includes the controls the caller did set, under the provider\u2019s own names', () => {
    const input = buildAnimateImageInput(
      validateAnimateImageRequest(
        body({ motionPrompt: 'a slow push in', negativePrompt: 'blur', seed: 7, duration: 9 })
      )
    );

    expect(input['prompt']).toBe('a slow push in');
    expect(input['negative_prompt']).toBe('blur');
    expect(input['seed']).toBe(7);
    expect(input['duration']).toBe(9);
    expect(input['resolution']).toBe('720P');
  });
});

describe('estimateAnimateCost', () => {
  it('multiplies the per-second rate for a model that publishes one', () => {
    const estimate = estimateAnimateCost(
      validateAnimateImageRequest(body({ resolution: '720P', duration: 5 }))
    );

    expect(estimate.known).toBe(true);
    expect(estimate.costUsd).toBeCloseTo(0.7, 10);
  });

  it('reads the exact published figure for a per-combination model', () => {
    const estimate = estimateAnimateCost(
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '768P', duration: 10 })
      )
    );

    expect(estimate.known).toBe(true);
    expect(estimate.costUsd).toBeCloseTo(0.56, 10);
  });

  // The assertion the whole `known` flag exists for. MiniMax's own figures imply 4.67¢ a second at
  // six seconds and 5.6¢ at ten, so interpolating a ten-second 1080P price would be this demo
  // inventing a number and presenting it as the provider's.
  it('reports an unpublished combination as unknown rather than interpolating it', () => {
    const estimate = estimateAnimateCost(
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '1080P', duration: 10 })
      )
    );

    expect(estimate.known).toBe(false);
    // Zero only because nothing is known. The flag is what stops a panel reading this as free.
    expect(estimate.costUsd).toBe(0);
  });

  it('never derives a per-second rate for a per-combination model', () => {
    const controls = modelsForTask('animate-image').find(
      (model) => model.id === MINIMAX
    )?.animateImageControls;

    expect(controls?.pricePerSecondUsd).toBeUndefined();
    expect(controls?.priceByCombinationUsd?.[priceCombinationKey('768P', 6)]).toBe(0.28);
  });
});

describe('describeAppliedAnimateControls', () => {
  it('echoes the settled controls, the verified source facts, and the estimate', () => {
    const applied = describeAppliedAnimateControls(
      validateAnimateImageRequest(body({ motionPrompt: 'drift', duration: 5 }))
    );

    expect(applied.model).toBe(ALIBABA);
    expect(applied.resolution).toBe('720P');
    expect(applied.duration).toBe(5);
    expect(applied.motionPrompt).toBe('drift');
    expect(applied.estimateKnown).toBe(true);
    // Read from the picture's own header, which is what lets the result layout describe what was
    // actually animated rather than repeating a browser's claim about a file.
    expect(applied.source.mediaType).toBe('image/png');
    expect(applied.source.width).toBeGreaterThan(0);
    expect(applied.source.height).toBeGreaterThan(0);
  });

  it('marks the estimate unknown when no price covers the combination', () => {
    const applied = describeAppliedAnimateControls(
      validateAnimateImageRequest(
        body({ model: MINIMAX, motionPrompt: 'drift', resolution: '1080P', duration: 10 })
      )
    );

    expect(applied.estimateKnown).toBe(false);
    expect(applied.estimatedCostUsd).toBe(0);
  });
});

describe('the registered image-to-video descriptors', () => {
  it('registers at least two models for comparison', () => {
    expect(modelsForTask('animate-image').length).toBeGreaterThanOrEqual(2);
  });

  // The constraint that decides whether a model can be offered at all. A model requiring a
  // fetchable HTTPS URL would mean publishing the visitor's picture for a third party to retrieve,
  // which is why `lightricks/ltx-2-5-fast` was probed and deliberately not registered.
  it('offers only models that accept an inline data URI', () => {
    for (const model of modelsForTask('animate-image')) {
      expect(model.animateImageControls?.imageDelivery, `${model.id} delivery`).toBe('data-uri');
    }
  });

  it('declares exactly one pricing shape per model', () => {
    for (const model of modelsForTask('animate-image')) {
      const controls = model.animateImageControls;
      const shapes = [controls?.pricePerSecondUsd, controls?.priceByCombinationUsd].filter(
        (shape) => shape !== undefined
      );
      // Two shapes would leave estimation with two answers for one run; none would leave it with
      // no way to quote a cost before a click that spends real money.
      expect(shapes, `${model.id} pricing shapes`).toHaveLength(1);
    }
  });

  it('declares exactly one duration shape per model', () => {
    for (const model of modelsForTask('animate-image')) {
      const controls = model.animateImageControls;
      const shapes = [controls?.durationRange, controls?.durationChoices].filter(
        (shape) => shape !== undefined
      );
      expect(shapes, `${model.id} duration shapes`).toHaveLength(1);
    }
  });

  it('defaults every model to a resolution and duration it actually accepts', () => {
    for (const model of modelsForTask('animate-image')) {
      const controls = model.animateImageControls;
      expect(controls?.resolutions, `${model.id} default resolution`).toContain(
        controls?.defaultResolution
      );

      const { defaultDuration, durationChoices, durationRange } = controls ?? {};
      if (durationChoices !== undefined) {
        expect(durationChoices, `${model.id} default duration`).toContain(defaultDuration);
      } else if (durationRange !== undefined && defaultDuration !== undefined) {
        expect(defaultDuration).toBeGreaterThanOrEqual(durationRange.min);
        expect(defaultDuration).toBeLessThanOrEqual(durationRange.max);
      }
    }
  });

  it('restricts every model\u2019s output to an explicit host allowlist', () => {
    for (const model of modelsForTask('animate-image')) {
      // A model that could name any host would make the Worker a general-purpose fetcher, since
      // the returned URL is retrieved server-side.
      expect(model.animateImageControls?.outputHosts.length, `${model.id} hosts`).toBeGreaterThan(
        0
      );
    }
  });
});
