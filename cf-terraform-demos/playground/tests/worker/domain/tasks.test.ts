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
      'animate-image',
      'chat',
      'classify-image',
      'classify-text',
      'create-image',
      'create-video',
      'describe-image',
      'detect-objects',
      'evaluate-choices',
      'generate-music',
      'read-text',
      'remix-image',
      'semantic-search',
      'transcribe-audio',
      'translate-text',
      'view-tokens'
    ]);
  });

  // The phase number is quoted in the placeholder, so a panel still marked planned for a phase
  // already delivered would tell a visitor to wait for something that exists.
  it('marks every panel from a delivered phase as available', () => {
    const deliveredThroughPhase = 17;
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
  // options cannot be demonstrated on an unfunded account. The three panels known to have no hosted
  // model must therefore stay after every panel that has one. Asserted so a future reshuffle has to
  // confront the constraint rather than quietly promote a credit-blocked panel ahead of a
  // credit-free one.
  //
  // **Phase 15 delivers the first credit-dependent panel.** Generate Music is built, marked
  // available, and bills against prepaid credits, so the assertion that no delivered panel is
  // credit-dependent is no longer true and has been replaced rather than deleted. What the ordering
  // rule actually promised was never "nothing paid is ever delivered" — it was "nothing paid is
  // delivered *before* everything free", and that is what is asserted below. The weaker reading
  // would have made the test expire the moment it mattered most.
  it('schedules credit-dependent panels after every credit-free one', () => {
    const creditDependent = new Set<TaskId>(['generate-music', 'animate-image']);

    const freePhases = TASK_DESCRIPTORS.filter((task) => !creditDependent.has(task.id)).map(
      (task) => task.phase
    );
    const paidPhases = TASK_DESCRIPTORS.filter((task) => creditDependent.has(task.id)).map(
      (task) => task.phase
    );

    expect(paidPhases.length).toBeGreaterThan(0);
    expect(freePhases.length).toBeGreaterThan(0);

    // The ordering constraint itself, across every panel rather than only the planned ones. Reading
    // it from the whole catalogue is what keeps it meaningful now that some paid panels are
    // delivered: a reshuffle that moved Animate Image ahead of a credit-free panel would fail here
    // whether or not either had shipped.
    //
    // **Phase 17 is a genuine, named exception to the rule, not a loosening of it.** Detect Objects
    // is credit-free and still sits after both paid panels, because the model that made it
    // deliverable at all — `@cf/moondream/moondream3.1-9B-A2B` — was not in the catalogue when the
    // sequence was ordered; the panel was blocked on a *missing* model rather than on credit. The
    // exception is therefore listed by name. Expressing it as a filter over phase numbers was tried
    // and rejected: `freePhases.filter((phase) => phase < min(paidPhases))` makes the assertion
    // describe whatever the data already says, so it would pass for any ordering whatsoever. A
    // named exemption keeps the rule falsifiable — adding a *new* credit-free panel after a paid
    // one still fails here, which is exactly the regression worth catching.
    const sequencedFreePhases = TASK_DESCRIPTORS.filter(
      (task) => !creditDependent.has(task.id) && task.id !== 'detect-objects'
    ).map((task) => task.phase);

    expect(Math.min(...paidPhases)).toBeGreaterThan(Math.max(...sequencedFreePhases));

    // Every credit-free panel is delivered, which is the precondition that made delivering a paid
    // one legitimate at all. If this ever fails, a credit-dependent panel has been built while a
    // credit-free one was still outstanding — the exact reordering this test exists to catch.
    const outstandingFree = TASK_DESCRIPTORS.filter(
      (task) => !creditDependent.has(task.id) && task.availability === 'planned'
    );
    expect(outstandingFree.map((task) => task.id)).toEqual([]);

    // Generate Music is the first paid panel delivered, so the remaining paid ones must still be
    // later than it. Pinning this keeps the sequence honest rather than leaving "after the free
    // ones" as the only surviving rule once more paid panels ship.
    const music = TASK_DESCRIPTORS.find((task) => task.id === 'generate-music');
    expect(music?.availability).toBe('available');

    const undeliveredPaid = TASK_DESCRIPTORS.filter(
      (task) => creditDependent.has(task.id) && task.availability === 'planned'
    );
    for (const task of undeliveredPaid) {
      expect(task.phase, `${task.name} follows the first delivered paid panel`).toBeGreaterThan(
        music?.phase ?? 0
      );
    }
  });

  // Detect Objects was listed for nine phases as "blocked: no model", because
  // `@cf/facebook/detr-resnet-50` had been removed from the catalogue and nothing replaced it.
  // Moondream 3.1 arriving with a dedicated `detect` mode is what unblocked it, and the panel is
  // Cloudflare-hosted, so it needs no prepaid credit. Both halves are asserted because the old
  // claim was wrong in both directions: the panel is no longer blocked, and it was never
  // credit-dependent.
  it('delivers Detect Objects as a credit-free panel once a hosted model exists', () => {
    const detect = TASK_DESCRIPTORS.find((task) => task.id === 'detect-objects');

    expect(detect?.availability).toBe('available');
    expect(detect?.gateway).toBe('required');

    // Every panel is now delivered, so no placeholder should remain anywhere in the catalogue.
    // This is the assertion that would have caught the stale "blocked" wording had it existed.
    expect(TASK_DESCRIPTORS.filter((task) => task.availability === 'planned')).toEqual([]);
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
