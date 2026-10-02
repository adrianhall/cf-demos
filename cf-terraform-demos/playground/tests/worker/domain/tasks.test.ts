import { describe, expect, it } from 'vitest';
import { findTask, isTaskId, TASK_DESCRIPTORS, type TaskId } from '../../../src/shared/tasks';

describe('TASK_DESCRIPTORS', () => {
  // Sixteen panels is the agreed product scope. Asserting the count catches a panel being dropped
  // in a refactor as well as one being added without a specification change.
  it('declares all sixteen panels', () => {
    expect(TASK_DESCRIPTORS).toHaveLength(16);
  });

  // The identifier doubles as the route segment and the API task parameter, so a duplicate would
  // make one panel unreachable and silently route its requests to the other.
  it('gives every panel a unique identifier', () => {
    const ids = TASK_DESCRIPTORS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every panel a unique display name', () => {
    const names = TASK_DESCRIPTORS.map((task) => task.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // A panel with no stated task type would leave a visitor unable to connect the plain action name
  // to anything they could look up in the model catalog, which is half of what the subtitle is for.
  it('gives every panel a task type and a summary', () => {
    for (const task of TASK_DESCRIPTORS) {
      expect(task.taskType.length).toBeGreaterThan(0);
      expect(task.summary.length).toBeGreaterThan(0);
    }
  });

  // The central invariant of the whole demo, asserted as data rather than as prose: there is no
  // "optional" or "preferred" gateway value a descriptor could quietly adopt.
  it('requires AI Gateway for every panel that performs inference', () => {
    const inferencePanels = TASK_DESCRIPTORS.filter((task) => task.id !== 'view-tokens');
    for (const task of inferencePanels) {
      expect(task.gateway).toBe('required');
    }
  });

  // View Tokens is the single exemption, and it is exempt because it performs no inference at all
  // rather than because it is allowed to skip the gateway. If a second panel ever declares `none`,
  // that is either a second local-only capability or a bypass wearing a disguise — both deserve a
  // failing test and a conversation.
  it('exempts only View Tokens, which performs no inference', () => {
    const exempt = TASK_DESCRIPTORS.filter((task) => task.gateway === 'none');
    expect(exempt.map((task) => task.id)).toEqual(['view-tokens']);
  });

  // Availability has to track what is actually built: a panel marked available while it renders
  // "not built yet" would make the sidebar lie in the one way a visitor notices immediately.
  // `tests/client/router.test.ts` enforces the other direction, that an available panel has a
  // view of its own.
  it('marks exactly the panels delivered so far as available', () => {
    const available = TASK_DESCRIPTORS.filter((task) => task.availability === 'available');
    expect(available.map((task) => task.id).sort()).toEqual([
      'chat',
      'classify-image',
      'create-image',
      'create-video',
      'describe-image',
      'read-text',
      'remix-image',
      'view-tokens'
    ]);
  });

  // The phase number is quoted in the placeholder, so a panel still marked planned for a phase
  // already delivered would tell a visitor to wait for something that exists.
  it('marks every panel from a delivered phase as available', () => {
    const deliveredThroughPhase = 9;
    for (const task of TASK_DESCRIPTORS) {
      if (task.phase <= deliveredThroughPhase) {
        expect(task.availability, `${task.name} is in a delivered phase`).toBe('available');
      } else {
        expect(task.availability, `${task.name} is not delivered yet`).toBe('planned');
      }
    }
  });

  it('records a delivery phase for every panel', () => {
    for (const task of TASK_DESCRIPTORS) {
      expect(task.phase).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every panel a distinct delivery phase', () => {
    // Two panels sharing a phase would make "the phase that delivers it" ambiguous in the
    // placeholder, and would hide a renumbering mistake — which is exactly what happens when the
    // plan is reordered and one entry is missed.
    const phases = TASK_DESCRIPTORS.map((task) => task.phase);
    expect(new Set(phases).size).toBe(phases.length);
  });

  // Phases 9 onward are ordered by whether Cloudflare hosts a model for the task, because a
  // third-party model bills against prepaid AI Gateway credits and a panel with only third-party
  // options cannot be built on an unfunded account. The three panels known to have no hosted model
  // must therefore stay after every panel that has one. Asserted so a future reshuffle has to
  // confront the constraint rather than quietly reintroduce a credit-blocked next phase.
  it('schedules credit-dependent panels after every credit-free one', () => {
    const creditDependent = new Set<TaskId>(['generate-music', 'animate-image', 'detect-objects']);

    const planned = TASK_DESCRIPTORS.filter((task) => task.availability === 'planned');
    const freePhases = planned
      .filter((task) => !creditDependent.has(task.id))
      .map((task) => task.phase);
    const paidPhases = planned
      .filter((task) => creditDependent.has(task.id))
      .map((task) => task.phase);

    expect(freePhases.length).toBeGreaterThan(0);
    expect(paidPhases.length).toBeGreaterThan(0);
    expect(Math.min(...paidPhases)).toBeGreaterThan(Math.max(...freePhases));
  });

  // Detect Objects has no model at all: `@cf/facebook/detr-resnet-50` was removed from the
  // catalogue, and neither catalogue declares an Object Detection task type. It stays listed so the
  // product's shape is visible, but it must remain the *last* panel phase — delivering it would
  // mean prompting a vision model for coordinates, which is the prose-parsing path the
  // specification rules out.
  it('keeps the panel with no available model last', () => {
    const detect = TASK_DESCRIPTORS.find((task) => task.id === 'detect-objects');
    const others = TASK_DESCRIPTORS.filter((task) => task.id !== 'detect-objects');

    expect(detect).toBeDefined();
    expect(detect!.phase).toBeGreaterThan(Math.max(...others.map((task) => task.phase)));
  });

  // Group labels are decorative, but an empty or whitespace label would still render as a gap in
  // the sidebar that looks like a bug.
  it('assigns every panel to a named visual group', () => {
    for (const task of TASK_DESCRIPTORS) {
      expect(task.group.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('findTask', () => {
  it('resolves a known panel', () => {
    expect(findTask('view-tokens')?.name).toBe('View Tokens');
  });

  it('returns undefined for an unknown identifier', () => {
    expect(findTask('summon-dragon')).toBeUndefined();
  });

  // A route parameter is a string from the URL bar. The lookup has to treat anything unrecognised
  // as absent rather than throwing, because a mistyped URL is routine, not exceptional.
  it('returns undefined for an empty identifier', () => {
    expect(findTask('')).toBeUndefined();
  });
});

describe('isTaskId', () => {
  it('accepts a known panel identifier', () => {
    expect(isTaskId('chat')).toBe(true);
  });

  it('rejects an unknown identifier', () => {
    expect(isTaskId('chat/../admin')).toBe(false);
  });
});
