import { beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/worker/application/admin-service.ts';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import { ShareService } from '../../src/worker/application/share-service.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeShareRepository } from './fake-share-repository.ts';
import { FakeUserRepository } from './fake-user-repository.ts';
import { expectRejectedProblemStatus } from './problem-details.ts';

/**
 * @file Covers the operator use cases against fakes rather than D1. Two properties matter more than
 *   the rest and neither is about SQL: the moderation delete must leave exactly the state an
 *   owner's own delete leaves — including the share cascade — and the moderation preview must never
 *   disclose whose diagram it is showing. Both are decisions this tier takes; the Workers-runtime
 *   suite then proves no layer above weakens them.
 */

/**
 * An ordinary signed-in owner.
 */
const ALICE = 'alice@example.com';

/**
 * A second ordinary owner, so "across every identity" means something.
 */
const BOB = 'bob@example.com';

/**
 * A syntactically valid id that no diagram has.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

let diagrams: FakeDiagramRepository;
let shares: FakeShareRepository;
let users: FakeUserRepository;
let diagramService: DiagramService;
let shareService: ShareService;
let service: AdminService;

beforeEach(() => {
  diagrams = new FakeDiagramRepository();
  shares = new FakeShareRepository();
  users = new FakeUserRepository(diagrams);
  diagramService = new DiagramService(diagrams, shares);
  shareService = new ShareService(shares, diagramService);
  service = new AdminService(users, diagramService);
});

/**
 * Creates a diagram owned by one identity.
 *
 * @param ownerEmail Identity that will own it.
 * @param title Title for the new diagram.
 * @returns The new diagram's id.
 */
async function createDiagram(ownerEmail: string, title = 'A Diagram'): Promise<string> {
  return (await diagramService.create(ownerEmail, { title })).id;
}

describe('the user directory', () => {
  it('reports every identity, not only the caller', async () => {
    await users.recordSeen(ALICE, '2026-01-01T00:00:00.000Z');
    await users.recordSeen(BOB, '2026-01-02T00:00:00.000Z');

    const page = await service.listUsers({});

    expect(page.users.map((user) => user.email)).toEqual([BOB, ALICE]);
    expect(page.total).toBe(2);
  });

  it('orders the directory by most recent activity', async () => {
    await users.recordSeen(ALICE, '2026-01-03T00:00:00.000Z');
    await users.recordSeen(BOB, '2026-01-01T00:00:00.000Z');

    const page = await service.listUsers({});

    expect(page.users[0]?.email).toBe(ALICE);
  });

  it('annotates each identity with the number of diagrams it owns', async () => {
    await users.recordSeen(ALICE, '2026-01-01T00:00:00.000Z');
    await users.recordSeen(BOB, '2026-01-02T00:00:00.000Z');
    await createDiagram(ALICE);
    await createDiagram(ALICE);
    await createDiagram(BOB);

    const page = await service.listUsers({});

    expect(page.users.find((user) => user.email === ALICE)?.diagramCount).toBe(2);
    expect(page.users.find((user) => user.email === BOB)?.diagramCount).toBe(1);
  });

  // The count is computed at read time rather than held in a column, which is what stops it
  // drifting after exactly the operation most likely to forget a counter: a moderation delete.
  it('follows a moderation delete rather than reporting a stale count', async () => {
    await users.recordSeen(ALICE, '2026-01-01T00:00:00.000Z');
    const id = await createDiagram(ALICE);

    await service.removeDiagram(id);

    expect((await service.listUsers({})).users[0]?.diagramCount).toBe(0);
  });

  it('reports an identity that has signed in but owns nothing', async () => {
    await users.recordSeen(ALICE, '2026-01-01T00:00:00.000Z');

    expect((await service.listUsers({})).users[0]?.diagramCount).toBe(0);
  });

  it('answers an empty directory successfully rather than as an error', async () => {
    await expect(service.listUsers({})).resolves.toEqual({
      limit: 20,
      offset: 0,
      total: 0,
      users: []
    });
  });

  describe('pagination', () => {
    beforeEach(async () => {
      for (let index = 0; index < 5; index += 1) {
        await users.recordSeen(`user-${index}@example.com`, `2026-01-0${index + 1}T00:00:00.000Z`);
      }
    });

    it('returns only the requested window', async () => {
      const page = await service.listUsers({ limit: '2', offset: '0' });

      expect(page.users).toHaveLength(2);
    });

    it('skips the requested number of rows', async () => {
      const first = await service.listUsers({ limit: '2', offset: '0' });
      const second = await service.listUsers({ limit: '2', offset: '2' });

      expect(second.users.map((user) => user.email)).not.toEqual(
        first.users.map((user) => user.email)
      );
    });

    // The total is what tells a client another page exists; a page of rows cannot say so itself.
    it('reports the whole directory size regardless of the window', async () => {
      expect((await service.listUsers({ limit: '2' })).total).toBe(5);
    });

    // Echoed from the validated value, not the raw query: a client that sent neither parameter
    // would otherwise have to hard-code this service's defaults to ask for the next page.
    it('echoes the window it actually used, including the defaults', async () => {
      await expect(service.listUsers({})).resolves.toMatchObject({ limit: 20, offset: 0 });
      await expect(service.listUsers({ limit: '2', offset: '4' })).resolves.toMatchObject({
        limit: 2,
        offset: 4
      });
    });

    it('answers an offset past the end with an empty page rather than an error', async () => {
      const page = await service.listUsers({ offset: '500' });

      expect(page.users).toEqual([]);
      expect(page.total).toBe(5);
    });

    it('refuses a malformed window before reading anything', async () => {
      await expectRejectedProblemStatus(service.listUsers({ limit: 'all' }), 422);
    });
  });
});

describe('the moderation preview', () => {
  it('reads any identity\u2019s diagram, not only the caller\u2019s', async () => {
    const id = await createDiagram(BOB, 'Bob\u2019s Diagram');

    await expect(service.getDiagram(id)).resolves.toMatchObject({
      id,
      title: 'Bob\u2019s Diagram'
    });
  });

  // The whole point of the preview: an administrator decides whether to delete a diagram by
  // looking at what it contains.
  it('carries the diagram\u2019s current graph', async () => {
    const id = await createDiagram(ALICE);
    await diagramService.saveGraph(ALICE, id, {
      graphData: JSON.stringify({
        edges: [],
        nodes: [{ id: 'n1' }],
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    });

    await expect(service.getDiagram(id)).resolves.toMatchObject({
      graphData: expect.stringContaining('n1')
    });
  });

  // The administrative surface must not become a second, broader way to read other people's
  // data. The directory answers "who owns how many" without naming a diagram; this answers "what
  // is in this diagram" without naming an owner. Composing them still yields neither.
  it('never discloses who owns the diagram', async () => {
    const id = await createDiagram(BOB);

    const diagram = await service.getDiagram(id);

    expect(diagram).not.toHaveProperty('ownerEmail');
    expect(JSON.stringify(diagram)).not.toContain(BOB);
  });

  it('reports a diagram that does not exist as not found', async () => {
    await expectRejectedProblemStatus(service.getDiagram(MISSING_ID), 404);
  });

  // Validated rather than passed through to storage. A malformed id is not a diagram, and
  // answering `404` keeps the administrative route from behaving differently to every other one.
  it('reports a malformed id as not found', async () => {
    await expectRejectedProblemStatus(service.getDiagram('not-a-uuid'), 404);
  });
});

describe('the moderation delete', () => {
  it('deletes a diagram the caller does not own', async () => {
    const id = await createDiagram(BOB);

    await service.removeDiagram(id);

    await expectRejectedProblemStatus(diagramService.get(BOB, id), 404);
  });

  // The property that makes routing this through the owner delete worthwhile. A moderated
  // diagram must leave no link still resolving, exactly as an owner's own delete does.
  it('cascades a revocation of every share link to the diagram', async () => {
    const id = await createDiagram(BOB);
    const created = await shareService.rotate(BOB, id);

    await service.removeDiagram(id);

    await expectRejectedProblemStatus(shareService.resolve(created.token), 404);
  });

  it('leaves no active share record behind in the operator\u2019s data', async () => {
    const id = await createDiagram(BOB);
    await shareService.rotate(BOB, id);

    await service.removeDiagram(id);

    await expect(shares.findActive(id)).resolves.toBeNull();
  });

  // The revoked row is kept rather than deleted, as a record that the link once existed.
  it('records when the cascaded revocation happened', async () => {
    const id = await createDiagram(BOB);
    await shareService.rotate(BOB, id);

    await service.removeDiagram(id);

    expect([...shares.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('leaves every other identity\u2019s diagrams alone', async () => {
    const target = await createDiagram(BOB);
    const bystander = await createDiagram(ALICE);

    await service.removeDiagram(target);

    await expect(diagramService.get(ALICE, bystander)).resolves.toMatchObject({ id: bystander });
  });

  it('reports a diagram that does not exist as not found', async () => {
    await expectRejectedProblemStatus(service.removeDiagram(MISSING_ID), 404);
  });

  it('reports a malformed id as not found', async () => {
    await expectRejectedProblemStatus(service.removeDiagram('not-a-uuid'), 404);
  });

  // A repeated delete must not become a way to revoke a link on a diagram that has since been
  // recreated with the same id, nor report success for work it did not do.
  it('reports a second delete of the same diagram as not found', async () => {
    const id = await createDiagram(BOB);
    await service.removeDiagram(id);

    await expectRejectedProblemStatus(service.removeDiagram(id), 404);
  });

  // A refused delete must not reach the cascade at all, or guessing ids would become a way to
  // revoke other people's links without deleting anything.
  it('revokes nothing when the delete itself was refused', async () => {
    const id = await createDiagram(BOB);
    await shareService.rotate(BOB, id);

    await expectRejectedProblemStatus(service.removeDiagram(MISSING_ID), 404);

    await expect(shares.findActive(id)).resolves.not.toBeNull();
  });
});
