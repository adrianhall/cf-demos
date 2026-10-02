/**
 * @file Domain tests for Create Video. The new thing in this panel is that two reviewed models
 *   expose the _same_ conceptual controls under different wire names, with differently spelled
 *   values — so the tests assert on the translation as heavily as on the validation. Cost
 *   estimation is also tested here rather than in the client, because the estimate a visitor is
 *   quoted and the one the server records have to be the same number.
 */

import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_PROMPT_CHARACTERS } from '../../../src/shared/create-video';
import {
  buildCreateVideoInput,
  describeAppliedVideoControls,
  estimateVideoCostUsd,
  validateCreateVideoRequest
} from '../../../src/worker/domain/create-video';
import { modelsForTask } from '../../../src/worker/domain/models';
import { problemWithStatus, thrownBy } from '../support/problem-details';

/**
 * Shape of a captured problem-details error, for asserting on its explanation.
 */
type ProblemLike = { problemDetails: { detail: string } };

/**
 * Every reviewed text-to-video model.
 */
const MODELS = modelsForTask('create-video');

/**
 * PixVerse, the default: `quality`/lowercase values, a duration range from 1, audio, negative
 * prompt.
 */
const PIXVERSE = MODELS.find((model) => model.id === 'pixverse/v6')!;

/**
 * Alibaba, the comparison: `resolution`/uppercase values, duration from 3, no audio, no negative
 * prompt.
 */
const ALIBABA = MODELS.find((model) => model.id === 'alibaba/hh1.1-t2v')!;

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
  return { prompt: 'A dog running', model: PIXVERSE.id, runId: RUN_ID, ...overrides };
}

describe('validateCreateVideoRequest', () => {
  it('accepts a minimal request and fills in the model defaults', () => {
    const request = validateCreateVideoRequest(body());

    expect(request.prompt).toBe('A dog running');
    expect(request.model.id).toBe(PIXVERSE.id);
    // Defaults are resolved during validation rather than left undefined, so the request builder
    // and the cost estimate work from one settled set of values.
    expect(request.resolution).toBe(PIXVERSE.videoControls?.defaultResolution);
    expect(request.duration).toBe(PIXVERSE.videoControls?.defaultDuration);
    expect(request.aspectRatio).toBe(PIXVERSE.videoControls?.defaultAspectRatio);
  });

  it('defaults to the cheapest resolution rather than the model’s own default', () => {
    // This is a cost decision expressed as a descriptor value, so it is asserted rather than
    // assumed: PixVerse's own schema default is 720p, and quietly inheriting it would make every
    // exploratory run nearly twice the price it needs to be.
    const controls = PIXVERSE.videoControls!;
    const cheapest = [...controls.resolutions].sort(
      (left, right) =>
        (controls.pricePerSecondUsd[left] ?? Infinity)
        - (controls.pricePerSecondUsd[right] ?? Infinity)
    )[0];

    expect(controls.defaultResolution).toBe(cheapest);
  });

  it('trims the prompt', () => {
    expect(validateCreateVideoRequest(body({ prompt: '  A dog  ' })).prompt).toBe('A dog');
  });

  it.each([
    ['a non-object body', 'not an object' as unknown],
    ['an array body', [] as unknown]
  ])('rejects %s', (_label, value) => {
    expect(thrownBy(() => validateCreateVideoRequest(value))).toMatchObject(problemWithStatus(400));
  });

  it.each(['user', 'email', 'actor', 'sub'])('rejects an identity field: %s', (field) => {
    const error = thrownBy(() => validateCreateVideoRequest(body({ [field]: 'x@example.com' })));
    expect(error).toMatchObject(problemWithStatus(400));
    expect((error as ProblemLike).problemDetails.detail).toContain(field);
  });

  it.each(['jobId', 'instanceId', 'workflowId', 'videoKey'])(
    'rejects a caller-named job field: %s',
    (field) => {
      // The job identifier is derived from the verified identity, so a caller supplying one is
      // either confused or probing. Either way it is refused explicitly rather than ignored.
      const error = thrownBy(() => validateCreateVideoRequest(body({ [field]: 'abc' })));
      expect(error).toMatchObject(problemWithStatus(400));
      expect((error as ProblemLike).problemDetails.detail).toContain(field);
    }
  );

  it('rejects an empty or whitespace-only prompt', () => {
    expect(thrownBy(() => validateCreateVideoRequest(body({ prompt: '   ' })))).toMatchObject(
      problemWithStatus(400)
    );
    expect(thrownBy(() => validateCreateVideoRequest(body({ prompt: '' })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects a prompt over the shared character cap', () => {
    const error = thrownBy(() =>
      validateCreateVideoRequest(body({ prompt: 'a'.repeat(MAX_VIDEO_PROMPT_CHARACTERS + 1) }))
    );
    expect(error).toMatchObject(problemWithStatus(400));
  });

  it('rejects an implausible run identifier', () => {
    expect(thrownBy(() => validateCreateVideoRequest(body({ runId: 'nope' })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects an unknown model', () => {
    expect(thrownBy(() => validateCreateVideoRequest(body({ model: 'nope/nope' })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects a model registered to another panel', () => {
    // A descriptor that exists but belongs elsewhere is the dangerous case: driving a classifier
    // with a video request shape would reach the provider as a malformed call.
    const error = thrownBy(() =>
      validateCreateVideoRequest(body({ model: '@cf/microsoft/resnet-50' }))
    );
    expect(error).toMatchObject(problemWithStatus(400));
  });

  describe('per-model control support', () => {
    it('rejects a negative prompt for a model that declares none', () => {
      const error = thrownBy(() =>
        validateCreateVideoRequest(
          body({ model: ALIBABA.id, negativePrompt: 'blurry', duration: 5 })
        )
      );
      expect(error).toMatchObject(problemWithStatus(400));
      expect((error as ProblemLike).problemDetails.detail).toContain('negativePrompt');
    });

    it('accepts a negative prompt for a model that declares one', () => {
      const request = validateCreateVideoRequest(body({ negativePrompt: 'blurry' }));
      expect(request.negativePrompt).toBe('blurry');
    });

    it('treats an empty negative prompt as absent rather than forwarding it', () => {
      // A provider is entitled to treat `""` as a meaningful instruction, so an empty field is
      // dropped rather than sent.
      expect(validateCreateVideoRequest(body({ negativePrompt: '   ' })).negativePrompt).toBe(
        undefined
      );
    });

    it('rejects audio for a model that generates none', () => {
      const error = thrownBy(() =>
        validateCreateVideoRequest(body({ model: ALIBABA.id, duration: 5, generateAudio: true }))
      );
      expect(error).toMatchObject(problemWithStatus(400));
      expect((error as ProblemLike).problemDetails.detail).toContain('generateAudio');
    });

    it('rejects a resolution spelled for the other model', () => {
      // The crux of this panel: `720p` is valid for PixVerse and invalid for Alibaba, which wants
      // `720P`. Accepting either would forward a value the provider's own enum rejects.
      expect(
        thrownBy(() => validateCreateVideoRequest(body({ model: ALIBABA.id, resolution: '720p' })))
      ).toMatchObject(problemWithStatus(400));
      expect(
        thrownBy(() => validateCreateVideoRequest(body({ resolution: '720P' })))
      ).toMatchObject(problemWithStatus(400));
    });

    it('accepts each model’s own resolution spellings', () => {
      expect(validateCreateVideoRequest(body({ resolution: '720p' })).resolution).toBe('720p');
      expect(
        validateCreateVideoRequest(body({ model: ALIBABA.id, resolution: '720P' })).resolution
      ).toBe('720P');
    });

    it('rejects an aspect ratio the model does not list', () => {
      // 21:9 is valid for PixVerse and absent from Alibaba's enum.
      expect(validateCreateVideoRequest(body({ aspectRatio: '21:9' })).aspectRatio).toBe('21:9');
      expect(
        thrownBy(() => validateCreateVideoRequest(body({ model: ALIBABA.id, aspectRatio: '21:9' })))
      ).toMatchObject(problemWithStatus(400));
    });
  });

  describe('duration', () => {
    it('rejects a fractional duration', () => {
      expect(thrownBy(() => validateCreateVideoRequest(body({ duration: 4.5 })))).toMatchObject(
        problemWithStatus(400)
      );
    });

    it('rejects a non-numeric duration', () => {
      expect(thrownBy(() => validateCreateVideoRequest(body({ duration: '5' })))).toMatchObject(
        problemWithStatus(400)
      );
    });

    it('enforces each model’s own lower bound', () => {
      // PixVerse accepts 1 second; Alibaba's range starts at 3. A single shared bound would be
      // wrong for one of them.
      expect(validateCreateVideoRequest(body({ duration: 1 })).duration).toBe(1);
      expect(
        thrownBy(() => validateCreateVideoRequest(body({ model: ALIBABA.id, duration: 1 })))
      ).toMatchObject(problemWithStatus(400));
    });

    it('accepts both range bounds inclusively', () => {
      const range = PIXVERSE.videoControls!.durationRange!;
      expect(validateCreateVideoRequest(body({ duration: range.min })).duration).toBe(range.min);
      expect(validateCreateVideoRequest(body({ duration: range.max })).duration).toBe(range.max);
    });

    it('rejects a duration above the range', () => {
      const range = PIXVERSE.videoControls!.durationRange!;
      expect(
        thrownBy(() => validateCreateVideoRequest(body({ duration: range.max + 1 })))
      ).toMatchObject(problemWithStatus(400));
    });
  });

  describe('seed', () => {
    it('accepts a whole number in range', () => {
      expect(validateCreateVideoRequest(body({ seed: 42 })).seed).toBe(42);
    });

    it.each([-1, 1.5, 2_147_483_648])('rejects an out-of-contract seed: %s', (seed) => {
      expect(thrownBy(() => validateCreateVideoRequest(body({ seed })))).toMatchObject(
        problemWithStatus(400)
      );
    });
  });
});

describe('buildCreateVideoInput', () => {
  it('translates this demo’s control names into PixVerse’s', () => {
    const input = buildCreateVideoInput(
      validateCreateVideoRequest(
        body({ resolution: '540p', aspectRatio: '9:16', duration: 8, generateAudio: false })
      )
    );

    expect(input).toEqual({
      prompt: 'A dog running',
      quality: '540p',
      aspect_ratio: '9:16',
      duration: 8,
      generate_audio: false
    });
  });

  it('translates them into Alibaba’s different names', () => {
    const input = buildCreateVideoInput(
      validateCreateVideoRequest(
        body({ model: ALIBABA.id, resolution: '1080P', aspectRatio: '9:16', duration: 6 })
      )
    );

    expect(input).toEqual({
      prompt: 'A dog running',
      resolution: '1080P',
      ratio: '9:16',
      duration: 6
    });
  });

  it('omits an audio field entirely for a model that declares none', () => {
    // Not `false` — omitted. Several of these schemas set `additionalProperties: false`, which makes
    // an undeclared field a request the provider may reject outright.
    const input = buildCreateVideoInput(
      validateCreateVideoRequest(body({ model: ALIBABA.id, duration: 5 }))
    );
    expect('generate_audio' in input).toBe(false);
    expect('audio' in input).toBe(false);
  });

  it('omits a negative prompt and seed the caller did not set', () => {
    const input = buildCreateVideoInput(validateCreateVideoRequest(body()));
    expect('negative_prompt' in input).toBe(false);
    expect('seed' in input).toBe(false);
  });

  it('forwards a negative prompt and seed under the provider’s names', () => {
    const input = buildCreateVideoInput(
      validateCreateVideoRequest(body({ negativePrompt: 'blurry', seed: 7 }))
    );
    expect(input['negative_prompt']).toBe('blurry');
    expect(input['seed']).toBe(7);
  });

  it('never includes a control name this demo invented', () => {
    // A guard against the translation silently regressing into passing our own vocabulary straight
    // through, which a provider would reject for reasons that look unrelated.
    const input = buildCreateVideoInput(
      validateCreateVideoRequest(body({ resolution: '720p', aspectRatio: '1:1', duration: 5 }))
    );
    for (const ours of ['resolution', 'aspectRatio', 'negativePrompt', 'generateAudio']) {
      // `resolution` is legitimate for Alibaba, so this only asserts it is absent from PixVerse's
      // payload, where the wire name is `quality`.
      expect(Object.hasOwn(input, ours)).toBe(false);
    }
  });
});

describe('estimateVideoCostUsd', () => {
  it('multiplies the model’s published per-second price by the duration', () => {
    const request = validateCreateVideoRequest(body({ resolution: '360p', duration: 4 }));
    expect(estimateVideoCostUsd(request)).toBeCloseTo(0.025 * 4, 6);
  });

  it('reflects how sharply resolution moves the price', () => {
    // The reason this panel estimates at all: the same prompt and duration costs an order of
    // magnitude more at the top setting than the bottom.
    const cheap = estimateVideoCostUsd(
      validateCreateVideoRequest(body({ resolution: '360p', duration: 5 }))
    );
    const dear = estimateVideoCostUsd(
      validateCreateVideoRequest(body({ model: ALIBABA.id, resolution: '1080P', duration: 15 }))
    );
    expect(dear / cheap).toBeGreaterThan(20);
  });

  it('reports an unknown price as zero rather than guessing', () => {
    // Every reviewed resolution has a price, so this asserts the shape of the fallback rather than a
    // reachable state: a descriptor added later without a full price list must not invent a figure.
    const request = validateCreateVideoRequest(body());
    const stripped = {
      ...request,
      controls: { ...request.controls, pricePerSecondUsd: {} }
    };
    expect(estimateVideoCostUsd(stripped)).toBe(0);
  });
});

describe('describeAppliedVideoControls', () => {
  it('echoes the settled controls including filled-in defaults', () => {
    const applied = describeAppliedVideoControls(validateCreateVideoRequest(body()));

    expect(applied.model).toBe(PIXVERSE.id);
    expect(applied.prompt).toBe('A dog running');
    expect(applied.resolution).toBe(PIXVERSE.videoControls?.defaultResolution);
    expect(applied.duration).toBe(PIXVERSE.videoControls?.defaultDuration);
    expect(applied.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('omits controls the caller never set', () => {
    const applied = describeAppliedVideoControls(validateCreateVideoRequest(body()));
    expect(applied.negativePrompt).toBe(undefined);
    expect(applied.seed).toBe(undefined);
  });

  it('quotes the same estimate the standalone estimator does', () => {
    // The route logs one and the response carries the other; a divergence would make the logged
    // estimate useless for comparison against reported cost.
    const request = validateCreateVideoRequest(body({ resolution: '1080p', duration: 12 }));
    expect(describeAppliedVideoControls(request).estimatedCostUsd).toBe(
      estimateVideoCostUsd(request)
    );
  });
});
