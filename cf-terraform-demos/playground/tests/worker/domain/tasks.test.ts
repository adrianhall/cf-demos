import { describe, expect, it } from 'vitest';
import { findTask, isTaskId, TASK_DESCRIPTORS } from '../../../src/shared/tasks';
import { modelsForTask } from '../../../src/worker/domain/models';

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

  // The badge invariant. `hosting` is declared on the panel so the sidebar can render without
  // waiting on `/api/catalogue`, which means it is a copy of something the model registry already
  // knows — and a copy can go stale. Adding a third-party model to a panel without updating its
  // flags would leave the sidebar claiming the panel runs free when it no longer entirely does.
  // Checked in both directions, against the registry itself.
  it('declares hosting flags matching the models actually registered for each panel', () => {
    for (const task of TASK_DESCRIPTORS) {
      const models = modelsForTask(task.id);

      expect(task.hosting.cloudflare, `${task.name} cloudflare flag`).toBe(
        models.some((model) => model.provider === 'workers-ai')
      );
      expect(task.hosting.thirdParty, `${task.name} thirdParty flag`).toBe(
        models.some((model) => model.provider === 'third-party')
      );
    }
  });

  // Three panels have no Cloudflare-hosted option at all, so they cannot be demonstrated on an
  // account without prepaid AI credits. Pinned by name rather than derived, because the point is
  // to notice when the set changes: a hosted text-to-video model appearing in the catalogue would
  // be good news that this test should force someone to act on.
  it('knows exactly which panels need prepaid credit to run at all', () => {
    const creditOnly = TASK_DESCRIPTORS.filter(
      (task) => task.hosting.thirdParty && !task.hosting.cloudflare
    );

    expect(creditOnly.map((task) => task.id).sort()).toEqual([
      'animate-image',
      'create-video',
      'generate-music'
    ]);
  });

  // Every inference panel has to offer something, and the one non-inference panel has to offer
  // nothing. A panel with no provider at all would render an empty selector.
  it('backs every inference panel with a provider, and only that panel set', () => {
    for (const task of TASK_DESCRIPTORS) {
      const badged = task.hosting.cloudflare || task.hosting.thirdParty;
      expect(badged, `${task.name} provider flags`).toBe(task.gateway === 'required');
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
