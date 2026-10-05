import { describe, expect, it } from 'vitest';
import { isTaskId, TASK_DESCRIPTORS, type TaskId } from '../../../src/shared/tasks';
import {
  defaultModelForTask,
  findModelForTask,
  MODEL_DESCRIPTORS,
  modelsForTask
} from '../../../src/worker/domain/models';

describe('MODEL_DESCRIPTORS', () => {
  // A descriptor exists only for a panel in the catalogue. A model bound to an identifier no
  // panel declares would be unreachable, and more usefully, this catches a panel renamed without
  // its descriptors following.
  it('registers models only against panels in the catalogue', () => {
    const panels = new Set(TASK_DESCRIPTORS.map((task) => task.id));
    for (const model of MODEL_DESCRIPTORS) {
      expect(panels.has(model.task), `${model.id} belongs to no known panel`).toBe(true);
    }
  });

  // Every inference panel needs at least one reviewed model, or its selector is empty and the
  // panel cannot be used at all.
  it('gives every inference panel a reviewed model', () => {
    const inferencePanels = TASK_DESCRIPTORS.filter((task) => task.gateway === 'required');
    for (const task of inferencePanels) {
      expect(modelsForTask(task.id).length, `${task.name} has no reviewed model`).toBeGreaterThan(
        0
      );
    }
  });

  it('binds every descriptor to a known panel', () => {
    for (const model of MODEL_DESCRIPTORS) {
      expect(isTaskId(model.task)).toBe(true);
    }
  });

  it('gives every descriptor a unique identifier within its panel', () => {
    const keys = MODEL_DESCRIPTORS.map((model) => `${model.task}:${model.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The contract version is what makes a stale descriptor detectable after a catalog page changes.
  // A zero or missing version would silently defeat that.
  it('pins a reviewed contract version on every descriptor', () => {
    for (const model of MODEL_DESCRIPTORS) {
      expect(model.contractVersion).toBeGreaterThan(0);
    }
  });

  it('links every descriptor to its catalog documentation', () => {
    for (const model of MODEL_DESCRIPTORS) {
      expect(model.documentationUrl.startsWith('https://')).toBe(true);
    }
  });

  // Beta status is the one descriptor fact that can change without anybody touching this
  // repository, and phase 18's reconciliation found it had: EmbeddingGemma was not beta when
  // phase 13 reviewed it and is now. The demo's convention is to say so in the display name, so
  // a visitor choosing between three embedding models knows which carries a stability caveat.
  //
  // This cannot assert *which* models are beta without calling the live catalogue, which would
  // make the suite depend on live infrastructure. What it can hold is the convention: the marker
  // lives in the name, lower-cased and parenthesised, so a future correction is a one-word edit
  // in a known shape rather than a new field invented at the point of need.
  it('marks a beta model in its display name, consistently', () => {
    const betaModels = MODEL_DESCRIPTORS.filter((model) => /beta/iu.test(model.name));

    expect(betaModels.length).toBeGreaterThan(0);
    for (const model of betaModels) {
      expect(model.name, `${model.id} should spell the marker "(beta)"`).toMatch(/ \(beta\)$/u);
    }
  });
});

describe('modelsForTask', () => {
  it('returns an empty list for an unknown task-like identifier', () => {
    expect(modelsForTask('not-a-reviewable-task' as TaskId)).toEqual([]);
  });

  it('returns every reviewed model bound to a panel, in catalogue order', () => {
    const models = modelsForTask('chat');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.task).toBe('chat');
    }
  });

  // Two Chat models rather than one, because comparing them is what makes the cost meter
  // instructive: the same prompt against a larger and a smaller model gives different figures.
  it('offers more than one Chat model to compare', () => {
    expect(modelsForTask('chat').length).toBeGreaterThanOrEqual(2);
  });

  // Chat streams, and a non-streaming descriptor on a streaming route would surface as an answer
  // that arrives all at once after a long pause.
  it('declares every Chat model as streamed', () => {
    for (const model of modelsForTask('chat')) {
      expect(model.invocation).toBe('streamed');
    }
  });

  // The context window is shown to the visitor and used to reject obviously oversized input, so a
  // text model without one would silently lose both.
  it('declares a context window for every Chat model', () => {
    for (const model of modelsForTask('chat')) {
      expect(model.contextWindowTokens).toBeGreaterThan(0);
    }
  });

  // Text generation is billed per token. Labelling it otherwise would make the figure read as
  // something it is not, which is the specific confusion the pricing unit exists to prevent.
  it('labels every Chat model as token-priced', () => {
    for (const model of modelsForTask('chat')) {
      expect(model.pricingUnit).toBe('token');
    }
  });
});

describe('defaultModelForTask', () => {
  it('returns the first reviewed model for a panel', () => {
    expect(defaultModelForTask('chat')?.id).toBe(modelsForTask('chat')[0]?.id);
  });

  it('returns undefined for an unknown task-like identifier', () => {
    expect(defaultModelForTask('not-a-reviewable-task' as TaskId)).toBeUndefined();
  });
});

describe('findModelForTask', () => {
  it('resolves a reviewed model registered for the panel', () => {
    const model = modelsForTask('chat')[0]!;
    expect(findModelForTask('chat', model.id)?.id).toBe(model.id);
  });

  // The task and the model are matched together deliberately. Looking a model up by identifier
  // alone would let a request name any reviewed model on any panel, which is how a narrow task API
  // turns into a generic passthrough.
  it('does not resolve a model that is not registered for the requested panel', () => {
    expect(findModelForTask('chat', '@cf/meta/llama-3.1-8b-instruct')).toBeUndefined();
  });

  it('does not resolve a Chat model against a different panel', () => {
    const model = modelsForTask('chat')[0]!;
    expect(findModelForTask('create-image', model.id)).toBeUndefined();
  });

  it('returns undefined for an empty model identifier', () => {
    expect(findModelForTask('chat', '')).toBeUndefined();
  });
});
