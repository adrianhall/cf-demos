import { describe, expect, it } from 'vitest';
import { findTask, isTaskId, TASK_DESCRIPTORS } from '../../../src/tasks';

describe('TASK_DESCRIPTORS', () => {
  // Fifteen panels is the agreed product scope. Asserting the count catches a panel being dropped
  // in a refactor as well as one being added without a specification change.
  it('declares all fifteen panels', () => {
    expect(TASK_DESCRIPTORS).toHaveLength(15);
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
      'create-image',
      'describe-image',
      'view-tokens'
    ]);
  });

  // The phase number is quoted in the placeholder, so a panel still marked planned for a phase
  // already delivered would tell a visitor to wait for something that exists.
  it('marks every panel from a delivered phase as available', () => {
    const deliveredThroughPhase = 5;
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
