import { beforeEach, describe, expect, it } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { ShareRepository } from '../../src/worker/application/ports/share-repository.ts';
import { ShareService } from '../../src/worker/application/share-service.ts';
import { shareTokenDigest } from '../../src/worker/domain/share-token.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeDiagramSessions } from './fake-diagram-sessions.ts';
import { FakeShareRepository } from './fake-share-repository.ts';
import { expectRejectedProblemStatus } from './problem-details.ts';

/**
 * @file Covers the sharing use cases against in-memory ports. Three claims are asserted here, and
 *   each of them is a security property rather than a convenience:
 *
 *   1. **Only an owner may manage a share.** Status, creation and revocation all answer the uniform
 *      `404` for a diagram that is absent, malformed or somebody else's — never a `403`, which
 *      would confirm a guessed id is real.
 *   2. **The raw token exists only in the creation result.** Nothing the service hands to a port, a
 *      store or a subsequent read contains it.
 *   3. **Resolution is anonymous but narrow.** A valid token yields a projection with no owner in it,
 *      and an unknown, revoked or malformed one is refused identically.
 */

const ALICE = 'alice@example.com';
const MALLORY = 'mallory@example.com';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

let diagrams: FakeDiagramRepository;
let shares: FakeShareRepository;
let diagramService: DiagramService;
let service: ShareService;

beforeEach(() => {
  diagrams = new FakeDiagramRepository();
  shares = new FakeShareRepository();
  diagramService = new DiagramService(diagrams, shares, new FakeDiagramSessions());
  service = new ShareService(shares, diagramService);
});

/**
 * Creates a diagram owned by one identity.
 *
 * @param ownerEmail Identity that will own it.
 * @returns The new diagram's id.
 */
async function createDiagram(ownerEmail: string): Promise<string> {
  return (await diagramService.create(ownerEmail, { title: 'Shared Diagram' })).id;
}

describe('reading share status', () => {
  it('reports no active share for a diagram that has never been shared', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.getStatus(ALICE, id)).resolves.toEqual({
      active: false,
      createdAt: null
    });
  });

  it('reports an active share and when it was created', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await expect(service.getStatus(ALICE, id)).resolves.toEqual({
      active: true,
      createdAt: created.createdAt
    });
  });

  // The status deliberately cannot reconstruct the link. Only a digest is stored, so this is the
  // shape of a fact rather than a withheld field.
  it('never carries a token or a URL', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    const status = await service.getStatus(ALICE, id);

    expect(Object.keys(status).sort()).toEqual(['active', 'createdAt']);
    expect(JSON.stringify(status)).not.toContain(created.token);
  });
});

describe('creating a share', () => {
  it('mints a well-formed token and a creation timestamp', async () => {
    const id = await createDiagram(ALICE);

    const created = await service.rotate(ALICE, id);

    expect(created.token).toMatch(/^[\w-]{43}$/u);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
  });

  // The claim the whole feature rests on. Everything the service wrote down is inspected, and the
  // token appears in none of it — only its digest does.
  it('stores the token\u2019s digest and never the token itself', async () => {
    const id = await createDiagram(ALICE);

    const created = await service.rotate(ALICE, id);

    const stored = JSON.stringify([...shares.rows, ...shares.lookup]);

    expect(stored).not.toContain(created.token);
    expect(stored).toContain(await shareTokenDigest(created.token));
  });

  it('makes the new token resolve to the diagram', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await expect(service.resolve(created.token)).resolves.toMatchObject({ id });
  });

  // At most one link per diagram is live at a time, so an owner never has to reason about which
  // of several links they have handed out still works.
  it('revokes the previous link when a new one is minted', async () => {
    const id = await createDiagram(ALICE);
    const first = await service.rotate(ALICE, id);

    const second = await service.rotate(ALICE, id);

    expect(second.token).not.toBe(first.token);
    await expectRejectedProblemStatus(service.resolve(first.token), 404);
    await expect(service.resolve(second.token)).resolves.toMatchObject({ id });
  });

  it('leaves exactly one active share after repeated rotation', async () => {
    const id = await createDiagram(ALICE);

    await service.rotate(ALICE, id);
    await service.rotate(ALICE, id);
    await service.rotate(ALICE, id);

    expect(shares.lookup.size).toBe(1);
    expect([...shares.rows.values()].filter((row) => row.revokedAt === null)).toHaveLength(1);
  });
});

describe('revoking a share', () => {
  it('stops the link resolving', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await service.revoke(ALICE, id);

    await expectRejectedProblemStatus(service.resolve(created.token), 404);
    await expect(service.getStatus(ALICE, id)).resolves.toEqual({
      active: false,
      createdAt: null
    });
  });

  // Reported as "not found" rather than silently succeeding: an owner pressing revoke twice has
  // asked about a link that is not there, and the honest answer is the one every other absent
  // share gets.
  it('refuses a revocation when no link is active', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.revoke(ALICE, id), 404);
  });

  it('refuses a second revocation of an already-revoked link', async () => {
    const id = await createDiagram(ALICE);
    await service.rotate(ALICE, id);
    await service.revoke(ALICE, id);

    await expectRejectedProblemStatus(service.revoke(ALICE, id), 404);
  });
});

describe('owner isolation', () => {
  /**
   * Every share operation, as the call a stranger would make.
   */
  const operations: [string, (id: string) => Promise<unknown>][] = [
    ['getStatus', async (id) => service.getStatus(MALLORY, id)],
    ['rotate', async (id) => service.rotate(MALLORY, id)],
    ['revoke', async (id) => service.revoke(MALLORY, id)]
  ];

  it.each(operations)('refuses %s for another identity\u2019s diagram', async (_name, call) => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(call(id), 404);
  });

  it.each(operations)('refuses %s for an unknown id identically', async (_name, call) => {
    await expectRejectedProblemStatus(call(MISSING_ID), 404);
  });

  it.each(operations)('refuses %s for a malformed id identically', async (_name, call) => {
    await expectRejectedProblemStatus(call('not-a-uuid'), 404);
  });

  // A refused creation must not leave a share behind, or guessing ids would be a way to mint
  // links against other people's diagrams.
  it('creates nothing when a stranger tries to share a diagram', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.rotate(MALLORY, id), 404);

    expect(shares.rows.size).toBe(0);
    await expect(service.getStatus(ALICE, id)).resolves.toMatchObject({ active: false });
  });

  // The inverse: a stranger must not be able to take an owner's working link away from them.
  it('leaves an owner\u2019s active link working after a stranger\u2019s revocation attempt', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await expectRejectedProblemStatus(service.revoke(MALLORY, id), 404);

    await expect(service.resolve(created.token)).resolves.toMatchObject({ id });
  });
});

describe('resolving a share anonymously', () => {
  it('returns the diagram\u2019s public fields', async () => {
    const id = await createDiagram(ALICE);
    await diagramService.updateMetadata(ALICE, id, { description: 'Notes', title: 'Public' });
    const created = await service.rotate(ALICE, id);

    await expect(service.resolve(created.token)).resolves.toEqual({
      description: 'Notes',
      graphData: expect.any(String) as string,
      id,
      title: 'Public'
    });
  });

  // A public link must never disclose whose diagram it points at.
  it('never discloses the owner', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    const shared = await service.resolve(created.token);

    expect(shared).not.toHaveProperty('ownerEmail');
    expect(JSON.stringify(shared)).not.toContain(ALICE);
  });

  // The live-pointer model: there is no snapshot, so an edit made after the link was handed out
  // is visible through that same link immediately.
  it('reflects an edit made after the link was created', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);
    const graphData = JSON.stringify({
      edges: [],
      nodes: [{ data: { label: 'Workers' }, id: 'n1' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    await diagramService.saveGraph(ALICE, id, { graphData });

    const shared = await service.resolve(created.token);

    expect(JSON.parse(shared.graphData)).toMatchObject({ nodes: [{ id: 'n1' }] });
  });

  it.each([
    ['an unknown token', 'z'.repeat(43)],
    ['a malformed token', 'nope'],
    ['an empty token', '']
  ])('refuses %s with the uniform 404', async (_label, token) => {
    await expectRejectedProblemStatus(service.resolve(token), 404);
  });

  // The statuses are identical; so must the details be, or the body becomes the oracle the status
  // code is not.
  it('refuses a revoked, an unknown and a malformed token with the same detail', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);
    await service.revoke(ALICE, id);

    const details = await Promise.all(
      [created.token, 'z'.repeat(43), 'nope'].map(async (token) =>
        service.resolve(token).then(
          () => 'resolved',
          (error: unknown) => JSON.stringify((error as { problemDetails: unknown }).problemDetails)
        )
      )
    );

    expect(new Set(details).size).toBe(1);
  });

  // The narrow window the resolver's own check exists for: a share whose records are intact but
  // whose diagram row has gone. Reported as a missing link rather than as a server error.
  it('refuses a token whose diagram no longer exists', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    diagrams.rows.delete(id);

    await expectRejectedProblemStatus(service.resolve(created.token), 404);
  });
});

describe('deleting a shared diagram', () => {
  // A link minted before the diagram was deleted must not keep resolving. The cascade lives in
  // the diagram use case, so it runs however the delete was reached.
  it('stops every link for that diagram resolving', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await diagramService.remove(ALICE, id);

    await expectRejectedProblemStatus(service.resolve(created.token), 404);
    expect(shares.lookup.size).toBe(0);
  });

  // The cascade must not become a way to revoke somebody else's share by guessing an id: it runs
  // only after the delete itself succeeded, which it never does for a stranger.
  it('revokes nothing when the delete was refused', async () => {
    const id = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, id);

    await expectRejectedProblemStatus(diagramService.remove(MALLORY, id), 404);

    await expect(service.resolve(created.token)).resolves.toMatchObject({ id });
  });

  it('deletes an unshared diagram without touching any share', async () => {
    const shared = await createDiagram(ALICE);
    const created = await service.rotate(ALICE, shared);
    const unshared = await createDiagram(ALICE);

    await diagramService.remove(ALICE, unshared);

    await expect(service.resolve(created.token)).resolves.toMatchObject({ id: shared });
  });
});

describe('the service\u2019s dependencies', () => {
  // The port is authorization-neutral on purpose: every ownership decision is made above it, so
  // the MCP tool layer in a later phase gets the identical rule by calling this service rather
  // than by re-deriving it over the same repository.
  it('makes no ownership decision inside the port', async () => {
    const id = await createDiagram(ALICE);
    await service.rotate(ALICE, id);
    const record = await shares.findActive(id);

    // The port happily answers for a diagram the caller does not own; the service is what refuses.
    expect(record).not.toBeNull();
    await expectRejectedProblemStatus(service.getStatus(MALLORY, id), 404);
  });

  it('accepts any conforming repository implementation', async () => {
    const custom: ShareRepository = new FakeShareRepository();
    const alternative = new ShareService(custom, diagramService);
    const id = await createDiagram(ALICE);

    const created = await alternative.rotate(ALICE, id);

    await expect(alternative.resolve(created.token)).resolves.toMatchObject({ id });
  });
});
