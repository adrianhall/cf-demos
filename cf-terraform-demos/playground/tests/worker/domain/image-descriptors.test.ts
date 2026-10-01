/**
 * @file Descriptor validation for the image panels. The specification requires a test confirming
 *   that each panel's controls map only to declared model capabilities, and this is it. It is
 *   written against the catalogue rather than against two named models on purpose. The regression
 *   worth preventing is a _future_ descriptor filled in carelessly — a step range whose default
 *   sits outside its own bounds, a model that declares guidance but forgets its range, a step
 *   parameter whose wire name was never recorded. A test naming today's two models could not catch
 *   any of those.
 */

import { describe, expect, it } from 'vitest';
import {
  IMAGE_CONTROL_NAMES,
  type ImageControlSupport,
  type NumericControlRange
} from '../../../src/images';
import { TASK_DESCRIPTORS } from '../../../src/tasks';
import {
  buildCreateImageInput,
  validateCreateImageRequest
} from '../../../src/worker/domain/create-image';
import { MODEL_DESCRIPTORS, modelsForTask } from '../../../src/worker/domain/models';

/**
 * Every reviewed text-to-image model.
 */
const imageModels = modelsForTask('create-image');

/**
 * Asserts that a numeric range is internally coherent.
 *
 * A default outside its own bounds is the specific error worth catching here: the UI shows it as
 * the starting value and the server would then refuse the very request the form produced.
 *
 * @param range Range to check.
 * @param label Control name, for the assertion message.
 * @returns Nothing; fails the test when the range is incoherent.
 */
function expectCoherentRange(range: NumericControlRange, label: string): void {
  expect(range.min, `${label} min below max`).toBeLessThan(range.max);
  expect(range.step, `${label} step is positive`).toBeGreaterThan(0);
  expect(range.default, `${label} default at or above min`).toBeGreaterThanOrEqual(range.min);
  expect(range.default, `${label} default at or below max`).toBeLessThanOrEqual(range.max);
}

describe('text-to-image descriptors', () => {
  it('registers at least two models so they can be compared', () => {
    expect(imageModels.length).toBeGreaterThanOrEqual(2);
  });

  describe.each(imageModels.map((model) => [model.name, model] as const))('%s', (_name, model) => {
    it('declares its image controls', () => {
      expect(model.imageControls).toBeDefined();
    });

    it('names the wire parameter for its step control when it has one', () => {
      if (model.imageControls?.steps !== undefined) {
        expect(model.stepsParameterName).toBeDefined();
      }
    });

    it('is priced per image', () => {
      expect(model.pricingUnit).toBe('image');
    });

    // A diffusion model returns one image at the end of its run. Declaring it streamed would send
    // the panel down a transport that has nothing to deliver incrementally.
    it('is synchronous rather than streamed', () => {
      expect(model.invocation).toBe('synchronous');
    });

    it('links to its catalog page', () => {
      expect(model.documentationUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//u);
    });

    it('declares a coherent range for every numeric control it exposes', () => {
      const controls = model.imageControls as ImageControlSupport;
      for (const key of ['dimensions', 'steps', 'guidance'] as const) {
        const range = controls[key];
        if (range !== undefined) {
          expectCoherentRange(range, `${model.name} ${key}`);
        }
      }
    });

    // The panel's controls must map only to declared capabilities. Driving this from the full
    // control list means a control added to the contract later is covered automatically.
    describe.each(IMAGE_CONTROL_NAMES)('the "%s" control', (control) => {
      /**
       * Whether this model declares the control.
       */
      const declared = ((): boolean => {
        const controls = model.imageControls as ImageControlSupport;
        switch (control) {
          case 'negativePrompt':
            return controls.negativePrompt;
          case 'seed':
            return controls.seed;
          case 'width':
          case 'height':
            return controls.dimensions !== undefined;
          case 'steps':
            return controls.steps !== undefined;
          case 'guidance':
            return controls.guidance !== undefined;
          default:
            // Unreachable while the switch covers every member of `IMAGE_CONTROL_NAMES`. Adding a
            // control to that list without handling it here fails the build at this assignment,
            // which is the point: a new control must not silently default to "not declared".
            return control satisfies never;
        }
      })();

      /**
       * A request body carrying just this control at a value valid for the model.
       *
       * @returns The body to validate.
       */
      function bodyWithControl(): Record<string, unknown> {
        const controls = model.imageControls as ImageControlSupport;
        const value =
          control === 'negativePrompt'
            ? 'avoid this'
            : control === 'seed'
              ? 1
              : control === 'width' || control === 'height'
                ? (controls.dimensions?.default ?? 1)
                : control === 'steps'
                  ? (controls.steps?.default ?? 1)
                  : (controls.guidance?.default ?? 1);

        return {
          prompt: 'x',
          model: model.id,
          runId: 'aaaaaaaa-1111-4222-8333-444455556666',
          [control]: value
        };
      }

      it(declared ? 'is accepted' : 'is refused', () => {
        if (declared) {
          expect(() => validateCreateImageRequest(bodyWithControl())).not.toThrow();
        } else {
          expect(() => validateCreateImageRequest(bodyWithControl())).toThrow(/does not support/u);
        }
      });
    });

    // A model whose schema forbids undeclared properties must receive only the fields it names.
    // Sending an extra is a request the provider is entitled to reject outright.
    it('builds an input containing only declared parameters', () => {
      const controls = model.imageControls as ImageControlSupport;
      const request = validateCreateImageRequest({
        prompt: 'x',
        model: model.id,
        runId: 'aaaaaaaa-1111-4222-8333-444455556666',
        ...(controls.steps === undefined ? {} : { steps: controls.steps.default }),
        ...(controls.negativePrompt ? { negativePrompt: 'avoid' } : {}),
        ...(controls.seed ? { seed: 5 } : {}),
        ...(controls.dimensions === undefined
          ? {}
          : { width: controls.dimensions.default, height: controls.dimensions.default }),
        ...(controls.guidance === undefined ? {} : { guidance: controls.guidance.default })
      });

      const input = buildCreateImageInput(request);
      const allowed = new Set(['prompt']);
      if (controls.negativePrompt) {
        allowed.add('negative_prompt');
      }
      if (controls.seed) {
        allowed.add('seed');
      }
      if (controls.dimensions !== undefined) {
        allowed.add('width');
        allowed.add('height');
      }
      if (controls.steps !== undefined) {
        allowed.add(model.stepsParameterName ?? 'steps');
      }
      if (controls.guidance !== undefined) {
        allowed.add('guidance');
      }

      for (const key of Object.keys(input)) {
        expect(allowed.has(key), `${key} is a declared parameter of ${model.name}`).toBe(true);
      }
    });
  });

  // Image controls belong to image models. A text model carrying them would mean the reviewed list
  // had been edited by copy-paste, and the Chat panel would start publishing controls it never uses.
  it('declares image controls only for text-to-image models', () => {
    for (const model of MODEL_DESCRIPTORS) {
      if (model.task !== 'create-image') {
        expect(model.imageControls, `${model.id} should have no image controls`).toBeUndefined();
      }
    }
  });

  it('gives every delivered inference panel at least one reviewed model', () => {
    const delivered = TASK_DESCRIPTORS.filter(
      (task) => task.availability === 'available' && task.gateway === 'required'
    );
    for (const task of delivered) {
      expect(modelsForTask(task.id).length, `${task.name} has no reviewed model`).toBeGreaterThan(
        0
      );
    }
  });
});
