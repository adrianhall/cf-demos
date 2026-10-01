import { describe, expect, it } from 'vitest';
import { isTaskId } from '../../../src/tasks';
import {
  findModelForTask,
  MODEL_DESCRIPTORS,
  modelsForTask
} from '../../../src/worker/domain/models';

describe('MODEL_DESCRIPTORS', () => {
  // Phases 1 and 2 deliver no inference panel, so advertising a model would promise capability the
  // application does not have. This assertion is expected to be replaced — not deleted — by Phase
  // 3, which is why it states the reason rather than just the number.
  it('is empty until the first inference panel ships in phase 3', () => {
    expect(MODEL_DESCRIPTORS).toHaveLength(0);
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
});

describe('modelsForTask', () => {
  it('returns an empty list for a panel with no reviewed model', () => {
    expect(modelsForTask('chat')).toEqual([]);
  });
});

describe('findModelForTask', () => {
  // The task and the model are matched together deliberately. Looking a model up by identifier
  // alone would let a request name any reviewed model on any panel, which is how a narrow task API
  // turns into a generic passthrough.
  it('does not resolve a model that is not registered for the requested panel', () => {
    expect(findModelForTask('chat', '@cf/meta/llama-3.1-8b-instruct')).toBeUndefined();
  });
});
