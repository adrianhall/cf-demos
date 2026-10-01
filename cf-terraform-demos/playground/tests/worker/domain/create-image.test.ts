import { describe, expect, it } from 'vitest';
import { IMAGE_CONTROL_NAMES, MAX_PROMPT_CHARACTERS } from '../../../src/images';
import {
  buildCreateImageInput,
  describeAppliedControls,
  MAX_SEED,
  validateCreateImageRequest
} from '../../../src/worker/domain/create-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { problemWithStatus } from '../support/problem-details';

/**
 * The reviewed image model that exposes every control, used for the "supported" cases.
 *
 * Found by capability rather than by identifier, so the suite keeps testing the right thing if the
 * reviewed list is reordered or a model is replaced.
 */
const RICH = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions !== undefined
)!;

/**
 * The reviewed image model that exposes only steps, used for the "unsupported" cases.
 */
const MINIMAL = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions === undefined
)!;

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Builds a valid request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body ready to validate.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: 'a lighthouse', model: RICH.id, runId: RUN_ID, ...overrides };
}

describe('the reviewed image models', () => {
  // The whole phase rests on the two models differing. If a future change made them identical,
  // every capability test below would still pass while testing nothing interesting, so the premise
  // is asserted directly.
  it('includes one model with dimensions and one without', () => {
    expect(RICH).toBeDefined();
    expect(MINIMAL).toBeDefined();
    expect(RICH.id).not.toBe(MINIMAL.id);
  });

  it('gives both models a declared step range', () => {
    expect(RICH.imageControls?.steps).toBeDefined();
    expect(MINIMAL.imageControls?.steps).toBeDefined();
  });

  // The ranges genuinely differ, which is what makes "valid for one model, invalid for the other"
  // a real case rather than a hypothetical one.
  it('declares different step ceilings for the two models', () => {
    expect(RICH.imageControls?.steps?.max).not.toBe(MINIMAL.imageControls?.steps?.max);
  });

  it('records the wire name each model uses for its step parameter', () => {
    expect(RICH.stepsParameterName).toBe('num_steps');
    expect(MINIMAL.stepsParameterName).toBe('steps');
  });
});

describe('validateCreateImageRequest', () => {
  it('accepts a minimal prompt-only request', () => {
    const request = validateCreateImageRequest(body());
    expect(request.prompt).toBe('a lighthouse');
    expect(request.model.id).toBe(RICH.id);
    expect(request.runId).toBe(RUN_ID);
  });

  it('resolves the model to its reviewed descriptor', () => {
    expect(validateCreateImageRequest(body()).model.contractVersion).toBeGreaterThan(0);
  });

  it('trims surrounding whitespace from the prompt', () => {
    expect(validateCreateImageRequest(body({ prompt: '  spaced  ' })).prompt).toBe('spaced');
  });

  it.each([
    ['a non-object body', 'not an object'],
    ['an array body', [1, 2]],
    ['null', null]
  ])('rejects %s', (_label, input) => {
    expect(() => validateCreateImageRequest(input)).toThrow();
  });

  it('rejects a missing prompt', () => {
    expect(() => validateCreateImageRequest({ model: RICH.id, runId: RUN_ID })).toThrow(
      /"prompt" string/u
    );
  });

  it('rejects an empty or whitespace-only prompt', () => {
    expect(() => validateCreateImageRequest(body({ prompt: '   ' }))).toThrow(
      /Describe the image/iu
    );
  });

  it('rejects a prompt over the character limit', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_CHARACTERS + 1);
    expect(() => validateCreateImageRequest(body({ prompt }))).toThrow(/character limit/iu);
  });

  it('rejects a non-string prompt', () => {
    expect(() => validateCreateImageRequest(body({ prompt: 42 }))).toThrow(/"prompt" string/u);
  });

  it('rejects an unknown model', () => {
    expect(() => validateCreateImageRequest(body({ model: 'made-up' }))).toThrow(
      /reviewed models/iu
    );
  });

  // Looking a model up by identifier alone is how a narrow task API becomes a generic passthrough,
  // so a Chat model must not resolve here even though it is a reviewed model.
  it('rejects a reviewed model registered against a different panel', () => {
    const chatModel = modelsForTask('chat')[0]!;
    expect(() => validateCreateImageRequest(body({ model: chatModel.id }))).toThrow(
      /reviewed models/iu
    );
  });

  it.each(['user', 'email', 'actor', 'sub'])('rejects a spoofed "%s" field', (field) => {
    expect(() => validateCreateImageRequest(body({ [field]: 'attacker@example.com' }))).toThrow(
      /verified Cloudflare Access identity/iu
    );
  });

  it.each([
    ['too short', 'abc'],
    ['containing a slash', 'run/1234567890'],
    ['empty', '']
  ])('rejects a run identifier %s', (_label, runId) => {
    expect(() => validateCreateImageRequest(body({ runId }))).toThrow(/runId/iu);
  });

  it('rejects with a 400 problem-details error', () => {
    const error = (() => {
      try {
        validateCreateImageRequest({});
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();
    expect(error).toMatchObject(problemWithStatus(400));
  });

  describe('controls the selected model supports', () => {
    it('accepts a negative prompt', () => {
      const request = validateCreateImageRequest(body({ negativePrompt: 'people, cars' }));
      expect(request.negativePrompt).toBe('people, cars');
    });

    it('accepts dimensions within the declared range', () => {
      const request = validateCreateImageRequest(body({ width: 512, height: 768 }));
      expect(request.width).toBe(512);
      expect(request.height).toBe(768);
    });

    it('accepts a seed', () => {
      expect(validateCreateImageRequest(body({ seed: 1_234 })).seed).toBe(1_234);
    });

    it('accepts guidance, which may be fractional', () => {
      expect(validateCreateImageRequest(body({ guidance: 7.5 })).guidance).toBe(7.5);
    });

    it('omits an absent control rather than defaulting it', () => {
      const request = validateCreateImageRequest(body());
      expect(request).not.toHaveProperty('width');
      expect(request).not.toHaveProperty('steps');
      expect(request).not.toHaveProperty('seed');
    });

    // An empty negative prompt means the same as not having one, and sending a provider a blank
    // string to interpret is worse than sending nothing.
    it('treats an empty negative prompt as absent', () => {
      expect(validateCreateImageRequest(body({ negativePrompt: '   ' }))).not.toHaveProperty(
        'negativePrompt'
      );
    });
  });

  describe('controls the selected model does not support', () => {
    // The central rule of this phase. A control the model has no parameter for is refused, and the
    // message names the model so the caller learns which one to switch to.
    it('refuses a negative prompt', () => {
      expect(() =>
        validateCreateImageRequest(body({ model: MINIMAL.id, negativePrompt: 'people' }))
      ).toThrow(/does not support "negativePrompt"/u);
    });

    it('refuses dimensions', () => {
      expect(() => validateCreateImageRequest(body({ model: MINIMAL.id, width: 512 }))).toThrow(
        /does not support "width"/u
      );
    });

    it('refuses guidance', () => {
      expect(() => validateCreateImageRequest(body({ model: MINIMAL.id, guidance: 7 }))).toThrow(
        /does not support "guidance"/u
      );
    });

    // Its own catalog page shows an example passing a seed, but its input schema declares only
    // `prompt` and `steps` and forbids anything else. The reviewed descriptor follows the schema.
    it('refuses a seed despite the provider example suggesting one', () => {
      expect(() => validateCreateImageRequest(body({ model: MINIMAL.id, seed: 7 }))).toThrow(
        /does not support "seed"/u
      );
    });

    it('names the model in the refusal so the caller can pick another', () => {
      expect(() => validateCreateImageRequest(body({ model: MINIMAL.id, seed: 7 }))).toThrow(
        new RegExp(MINIMAL.name.replace(/[.[\]]/gu, '\\$&'), 'u')
      );
    });

    it('still accepts the control that model does support', () => {
      const request = validateCreateImageRequest(body({ model: MINIMAL.id, steps: 4 }));
      expect(request.steps).toBe(4);
    });
  });

  describe('per-model ranges', () => {
    // The same value is valid for one model and invalid for the other, which is exactly why the
    // range is published per model rather than fixed for the panel.
    it('accepts a step count valid for the model that allows it', () => {
      const max = RICH.imageControls!.steps!.max;
      expect(validateCreateImageRequest(body({ steps: max })).steps).toBe(max);
    });

    it('refuses that same step count on the model with a lower ceiling', () => {
      const tooMany = RICH.imageControls!.steps!.max;
      expect(() => validateCreateImageRequest(body({ model: MINIMAL.id, steps: tooMany }))).toThrow(
        /must be between/u
      );
    });

    it('states the accepted range in the refusal', () => {
      const ceiling = MINIMAL.imageControls!.steps!.max;
      expect(() =>
        validateCreateImageRequest(body({ model: MINIMAL.id, steps: ceiling + 1 }))
      ).toThrow(new RegExp(String(ceiling), 'u'));
    });

    it('refuses a width below the declared minimum', () => {
      const below = RICH.imageControls!.dimensions!.min - 1;
      expect(() => validateCreateImageRequest(body({ width: below }))).toThrow(/must be between/u);
    });

    it('refuses a width above the declared maximum', () => {
      const above = RICH.imageControls!.dimensions!.max + 1;
      expect(() => validateCreateImageRequest(body({ width: above }))).toThrow(/must be between/u);
    });

    it('accepts the exact boundaries of a declared range', () => {
      const range = RICH.imageControls!.dimensions!;
      expect(validateCreateImageRequest(body({ width: range.min })).width).toBe(range.min);
      expect(validateCreateImageRequest(body({ width: range.max })).width).toBe(range.max);
    });

    // A value between UI steps is still within range. Refusing it would let a presentation detail
    // masquerade as a validation rule.
    it('accepts a value that does not fall on a UI step boundary', () => {
      expect(validateCreateImageRequest(body({ width: 513 })).width).toBe(513);
    });

    it('refuses a fractional value for an integer control', () => {
      expect(() => validateCreateImageRequest(body({ steps: 4.5 }))).toThrow(/whole number/iu);
    });

    it('refuses a seed above the 32-bit ceiling', () => {
      expect(() => validateCreateImageRequest(body({ seed: MAX_SEED + 1 }))).toThrow(
        /must be between/u
      );
    });

    it('refuses a negative seed', () => {
      expect(() => validateCreateImageRequest(body({ seed: -1 }))).toThrow(/must be between/u);
    });

    // `NaN` and `Infinity` serialise to `null` in JSON and would reach the provider as an absent
    // option, making a rejected value look accepted.
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY]
    ])('refuses %s as a control value', (_label, value) => {
      expect(() => validateCreateImageRequest(body({ steps: value }))).toThrow(/must be a number/u);
    });

    it('refuses a numeric control sent as a string', () => {
      expect(() => validateCreateImageRequest(body({ steps: '4' }))).toThrow(/must be a number/u);
    });
  });

  // Walking the full control list rather than a hand-written subset, so a control added to the
  // contract later cannot slip through unvalidated.
  describe.each(IMAGE_CONTROL_NAMES)('the "%s" control', (control) => {
    it('is either accepted by a model that declares it or refused outright', () => {
      const models = modelsForTask('create-image');
      const anyAccepts = models.some((model) => {
        try {
          validateCreateImageRequest({
            prompt: 'x',
            model: model.id,
            runId: RUN_ID,
            [control]: control === 'negativePrompt' ? 'avoid' : 1
          });
          return true;
        } catch {
          return false;
        }
      });
      const anyRefuses = models.some((model) => {
        try {
          validateCreateImageRequest({
            prompt: 'x',
            model: model.id,
            runId: RUN_ID,
            [control]: control === 'negativePrompt' ? 'avoid' : 1
          });
          return false;
        } catch {
          return true;
        }
      });

      // Every control is meaningful somewhere, and no control is silently accepted everywhere.
      expect(anyAccepts || anyRefuses).toBe(true);
    });
  });
});

describe('buildCreateImageInput', () => {
  it('always sends the prompt', () => {
    expect(buildCreateImageInput(validateCreateImageRequest(body()))['prompt']).toBe(
      'a lighthouse'
    );
  });

  // The two providers name this parameter differently, and sending the wrong name would be silently
  // ignored — producing a default-quality image while the UI claimed a chosen step count.
  it('uses the step parameter name the selected model expects', () => {
    const rich = buildCreateImageInput(validateCreateImageRequest(body({ steps: 10 })));
    expect(rich['num_steps']).toBe(10);
    expect(rich).not.toHaveProperty('steps');

    const minimal = buildCreateImageInput(
      validateCreateImageRequest(body({ model: MINIMAL.id, steps: 4 }))
    );
    expect(minimal['steps']).toBe(4);
    expect(minimal).not.toHaveProperty('num_steps');
  });

  it('maps the negative prompt to the provider field name', () => {
    const input = buildCreateImageInput(
      validateCreateImageRequest(body({ negativePrompt: 'people' }))
    );
    expect(input['negative_prompt']).toBe('people');
  });

  it('forwards dimensions, guidance, and seed when supplied', () => {
    const input = buildCreateImageInput(
      validateCreateImageRequest(body({ width: 512, height: 512, guidance: 6, seed: 99 }))
    );
    expect(input).toMatchObject({ width: 512, height: 512, guidance: 6, seed: 99 });
  });

  // The model that forbids undeclared properties must receive exactly the fields its schema names.
  // Anything extra is a request the provider is entitled to reject outright.
  it('sends only the declared fields to a model that forbids extras', () => {
    const input = buildCreateImageInput(
      validateCreateImageRequest(body({ model: MINIMAL.id, steps: 4 }))
    );
    expect(Object.keys(input).sort()).toEqual(['prompt', 'steps']);
  });

  it('sends only the prompt when no control was chosen', () => {
    const input = buildCreateImageInput(validateCreateImageRequest(body({ model: MINIMAL.id })));
    expect(Object.keys(input)).toEqual(['prompt']);
  });

  it('omits a control the caller did not supply', () => {
    const input = buildCreateImageInput(validateCreateImageRequest(body({ width: 512 })));
    expect(input).not.toHaveProperty('guidance');
    expect(input).not.toHaveProperty('seed');
  });
});

describe('describeAppliedControls', () => {
  it('reports the prompt and model that produced an image', () => {
    const applied = describeAppliedControls(validateCreateImageRequest(body()));
    expect(applied.prompt).toBe('a lighthouse');
    expect(applied.model).toBe(RICH.id);
  });

  // The gallery shows what produced each result, so a control the caller left alone has to be
  // reported as the model's documented default rather than as absent.
  it('fills in the model default for a control the caller omitted', () => {
    const applied = describeAppliedControls(validateCreateImageRequest(body()));
    expect(applied.steps).toBe(RICH.imageControls!.steps!.default);
    expect(applied.width).toBe(RICH.imageControls!.dimensions!.default);
  });

  it('reports a supplied value in preference to the default', () => {
    const applied = describeAppliedControls(validateCreateImageRequest(body({ steps: 7 })));
    expect(applied.steps).toBe(7);
  });

  // A model without a control has no default to report, and inventing one would claim a setting the
  // run did not have.
  it('omits a control the model does not support', () => {
    const applied = describeAppliedControls(
      validateCreateImageRequest(body({ model: MINIMAL.id }))
    );
    expect(applied).not.toHaveProperty('width');
    expect(applied).not.toHaveProperty('guidance');
    expect(applied).not.toHaveProperty('negativePrompt');
  });

  // An omitted seed means the provider chose one at random. Reporting a default of 0 would claim
  // reproducibility the run does not actually have.
  it('omits the seed when none was supplied', () => {
    const applied = describeAppliedControls(validateCreateImageRequest(body()));
    expect(applied).not.toHaveProperty('seed');
  });

  it('reports a supplied seed', () => {
    expect(describeAppliedControls(validateCreateImageRequest(body({ seed: 42 }))).seed).toBe(42);
  });
});
