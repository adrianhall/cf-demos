import { beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../../src/worker/application/collaborator-service.ts';
import { FakeCollaboratorRepository } from './fake-collaborator-repository.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeUserRepository } from './fake-user-repository.ts';
import { expectRejectedProblemStatus } from './problem-details.ts';

/**
 * @file Covers the collaboration use cases against in-memory ports. The assertions that matter here
 *   are the refusals, and specifically their _shape_: a stranger, a collaborator attempting an
 *   owner-only action, and an identity naming a diagram that does not exist must all be
 *   indistinguishable, because anything that tells them apart lets a caller confirm that a guessed
 *   id belongs to somebody. The two refusals that deliberately are _not_ uniform are tested as
 *   such, with the reasoning recorded beside them. The fakes take no authorization decisions at
 *   all, which is what makes these tests meaningful: if a rule were missing from the service, the
 *   fake would happily let one collaborator evict another.
 */

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const MALLORY = 'mallory@example.com';

/**
 * A valid diagram id that no diagram has.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A fixed clock, so an assertion about a recorded timestamp names a constant rather than tolerating
 * whatever "now" happened to be.
 */
const GRANTED_AT = '2026-02-01T00:00:00.000Z';

/**
 * Clock injected into every grant, returning {@link GRANTED_AT}.
 *
 * @returns The fixed grant time.
 */
const clock = () => new Date(GRANTED_AT);

let diagrams: FakeDiagramRepository;
let grants: FakeCollaboratorRepository;
let users: FakeUserRepository;
let service: CollaboratorService;

beforeEach(async () => {
  diagrams = new FakeDiagramRepository();
  grants = new FakeCollaboratorRepository(diagrams);
  users = new FakeUserRepository(diagrams);
  service = new CollaboratorService(grants, diagrams, users);

  // Everybody in these tests except Carol has signed in, which is what makes Carol usable as the
  // "never signed in" case without a second fixture.
  for (const email of [ALICE, BOB, MALLORY]) {
    await users.recordSeen(email, '2026-01-01T00:00:00.000Z');
  }
});

/**
 * Creates a diagram owned by one identity.
 *
 * @param ownerEmail Identity that will own it.
 * @param title Title for the new diagram.
 * @returns The created diagram's id.
 */
async function createDiagram(ownerEmail: string, title = 'Diagram'): Promise<string> {
  return (await diagrams.create(ownerEmail, { title }, '{}')).id;
}

/**
 * Creates a diagram owned by Alice with Bob already added as a collaborator.
 *
 * @returns The diagram's id.
 */
async function sharedDiagram(): Promise<string> {
  const id = await createDiagram(ALICE, "Alice's");
  await service.add(ALICE, id, { email: BOB }, clock);
  return id;
}

describe('resolving a diagram the actor may reach', () => {
  it('reports the owner as owner', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.requireAccessible(ALICE, id)).resolves.toMatchObject({
      diagram: { id, ownerEmail: ALICE },
      role: 'owner'
    });
  });

  it('reports a collaborator as editor, on the same diagram', async () => {
    const id = await sharedDiagram();

    await expect(service.requireAccessible(BOB, id)).resolves.toMatchObject({
      diagram: { id, ownerEmail: ALICE },
      role: 'editor'
    });
  });

  it.each([
    ['a stranger', () => MALLORY],
    ['somebody who has never signed in', () => CAROL]
  ])('refuses %s with 404', async (_name, actor) => {
    const id = await sharedDiagram();

    await expectRejectedProblemStatus(service.requireAccessible(actor(), id), 404);
  });

  it.each([
    ['an unknown id', () => MISSING_ID],
    ['a malformed id', () => 'not-a-uuid']
  ])('refuses %s with 404', async (_name, id) => {
    await expectRejectedProblemStatus(service.requireAccessible(ALICE, id()), 404);
  });

  // The three must be byte-identical, or the detail becomes the oracle the status deliberately is
  // not: a caller comparing bodies could tell a real id apart from a guessed one.
  it('refuses a foreign, an unknown and a malformed id with the same detail', async () => {
    const id = await createDiagram(ALICE);

    const details = await Promise.all(
      [id, MISSING_ID, 'not-a-uuid'].map(async (candidate) =>
        service
          .requireAccessible(MALLORY, candidate)
          .catch((error: unknown) =>
            JSON.stringify((error as { problemDetails: unknown }).problemDetails)
          )
      )
    );

    expect(new Set(details).size).toBe(1);
  });

  // A grant is scoped to one diagram. Being added to one must not be a way into another the same
  // owner happens to have.
  it('does not let a grant on one diagram reach another', async () => {
    const shared = await sharedDiagram();
    const other = await createDiagram(ALICE, 'Not shared');

    await expect(service.requireAccessible(BOB, shared)).resolves.toMatchObject({
      role: 'editor'
    });
    await expectRejectedProblemStatus(service.requireAccessible(BOB, other), 404);
  });
});

describe('resolving a diagram the actor owns', () => {
  it('returns the diagram for its owner', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.requireOwner(ALICE, id)).resolves.toMatchObject({ id });
  });

  // A `404` rather than a `403`, even though a collaborator can plainly see the diagram. The
  // status discloses nothing either way here; giving every refusal on a diagram route one shape
  // is what keeps a `403` from appearing somewhere it would be a signal.
  it('refuses a collaborator with 404, not 403', async () => {
    const id = await sharedDiagram();

    await expectRejectedProblemStatus(service.requireOwner(BOB, id), 404);
  });
});

describe('listing a diagram\u2019s collaborators', () => {
  it('is readable by the owner', async () => {
    const id = await sharedDiagram();

    await expect(service.list(ALICE, id)).resolves.toMatchObject([{ collaboratorEmail: BOB }]);
  });

  // A collaborator may see who else is editing. Withholding it would make a shared document feel
  // like a private one that happens to change by itself.
  it('is readable by a collaborator', async () => {
    const id = await sharedDiagram();

    await expect(service.list(BOB, id)).resolves.toMatchObject([{ collaboratorEmail: BOB }]);
  });

  it('refuses a stranger with 404', async () => {
    const id = await sharedDiagram();

    await expectRejectedProblemStatus(service.list(MALLORY, id), 404);
  });

  it('answers an unshared diagram with an empty list rather than an error', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.list(ALICE, id)).resolves.toEqual([]);
  });
});

describe('adding a collaborator', () => {
  it('records the grant with the owner as its author', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.add(ALICE, id, { email: BOB }, clock)).resolves.toEqual({
      addedAt: GRANTED_AT,
      addedBy: ALICE,
      collaboratorEmail: BOB,
      diagramId: id,
      displayName: null
    });
  });

  it('grants edit access the target did not have a moment before', async () => {
    const id = await createDiagram(ALICE);
    await expectRejectedProblemStatus(service.requireAccessible(BOB, id), 404);

    await service.add(ALICE, id, { email: BOB }, clock);

    await expect(service.requireAccessible(BOB, id)).resolves.toMatchObject({ role: 'editor' });
  });

  // Idempotent: the caller asked for a state that is now true, so reporting a conflict would make
  // every client special-case an outcome it already has.
  it('succeeds when the person is already a collaborator', async () => {
    const id = await sharedDiagram();

    await expect(service.add(ALICE, id, { email: BOB }, clock)).resolves.toMatchObject({
      collaboratorEmail: BOB
    });
    await expect(service.list(ALICE, id)).resolves.toHaveLength(1);
  });

  // Re-adding is not a new grant. Rewriting the audit trail would erase when access was actually
  // given, which is the one question the stored columns exist to answer.
  it('leaves the original grant\u2019s author and timestamp intact on a re-add', async () => {
    const id = await createDiagram(ALICE);
    await service.add(ALICE, id, { email: BOB }, () => new Date('2026-01-05T00:00:00.000Z'));

    const second = await service.add(ALICE, id, { email: BOB }, clock);

    expect(second.addedAt).toBe('2026-01-05T00:00:00.000Z');
  });

  it('refuses an address that has never signed in with 404', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.add(ALICE, id, { email: CAROL }, clock), 404);
  });

  // The message is the whole point of this refusal: it tells the owner what to do about it. A
  // uniform "Diagram not found." would send them looking for a diagram that is open in front of
  // them.
  it('tells the owner that person must sign in first', async () => {
    const id = await createDiagram(ALICE);

    await expect(service.add(ALICE, id, { email: CAROL }, clock)).rejects.toMatchObject({
      problemDetails: { detail: expect.stringContaining('has not signed in') }
    });
  });

  it('writes nothing when the address has never signed in', async () => {
    const id = await createDiagram(ALICE);

    await service.add(ALICE, id, { email: CAROL }, clock).catch(() => undefined);

    expect(grants.rows.size).toBe(0);
  });

  // Exact comparison, matching every other identity comparison in the application. A
  // differently-cased address is simply an address the directory does not hold.
  it('refuses a differently-cased spelling of a signed-in address', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(
      service.add(ALICE, id, { email: 'BOB@example.com' }, clock),
      404
    );
  });

  it('refuses the owner adding themselves with 400', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.add(ALICE, id, { email: ALICE }, clock), 400);
  });

  it('refuses a collaborator adding somebody else with 404', async () => {
    const id = await sharedDiagram();
    await users.recordSeen(MALLORY, '2026-01-01T00:00:00.000Z');

    await expectRejectedProblemStatus(service.add(BOB, id, { email: MALLORY }, clock), 404);
    await expect(service.list(ALICE, id)).resolves.toHaveLength(1);
  });

  it('refuses a stranger adding anybody with 404', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.add(MALLORY, id, { email: BOB }, clock), 404);
    expect(grants.rows.size).toBe(0);
  });

  // Validated before the diagram is read, so a malformed body cannot be used to probe which ids
  // exist: the refusal is the same whether the diagram is real or not.
  it('refuses a malformed email with 422, whether or not the diagram exists', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.add(ALICE, id, { email: 'nope' }, clock), 422);
    await expectRejectedProblemStatus(
      service.add(ALICE, MISSING_ID, { email: 'nope' }, clock),
      422
    );
  });
});

describe('removing a collaborator', () => {
  it('lets the owner remove somebody', async () => {
    const id = await sharedDiagram();

    await service.remove(ALICE, id, BOB);

    await expect(service.list(ALICE, id)).resolves.toEqual([]);
    await expectRejectedProblemStatus(service.requireAccessible(BOB, id), 404);
  });

  it('lets a collaborator remove themselves', async () => {
    const id = await sharedDiagram();

    await service.remove(BOB, id, BOB);

    await expect(service.list(ALICE, id)).resolves.toEqual([]);
  });

  // The rule that needs two collaborators to express, and the one a fake taking no decisions
  // cannot enforce on the service's behalf.
  it('refuses a collaborator removing a different collaborator', async () => {
    const id = await sharedDiagram();
    await service.add(ALICE, id, { email: MALLORY }, clock);

    await expectRejectedProblemStatus(service.remove(BOB, id, MALLORY), 404);

    // Still there: the refusal happened before anything was deleted.
    await expect(service.list(ALICE, id)).resolves.toMatchObject([
      { collaboratorEmail: BOB },
      { collaboratorEmail: MALLORY }
    ]);
  });

  it('refuses a stranger removing anybody', async () => {
    const id = await sharedDiagram();

    await expectRejectedProblemStatus(service.remove(MALLORY, id, BOB), 404);
    await expect(service.list(ALICE, id)).resolves.toHaveLength(1);
  });

  // Refused rather than quietly reported as success, so a client that repeats a removal is told
  // the second one did nothing.
  it('refuses removing somebody who is not a collaborator with 404', async () => {
    const id = await createDiagram(ALICE);

    await expectRejectedProblemStatus(service.remove(ALICE, id, BOB), 404);
  });

  it('refuses a malformed email with 422', async () => {
    const id = await sharedDiagram();

    await expectRejectedProblemStatus(service.remove(ALICE, id, 'nope'), 422);
  });
});

describe('listing the diagrams shared with an identity', () => {
  it('returns a diagram somebody else shared, with its owner', async () => {
    const id = await sharedDiagram();

    await expect(service.listSharedWithMe(BOB)).resolves.toMatchObject([{ id, ownerEmail: ALICE }]);
  });

  // The two dashboard sections must be disjoint. An owner cannot be added to their own diagram,
  // so nothing can appear in both — and this proves it from both directions rather than only
  // asserting the shared list.
  it('never overlaps the identity\u2019s own diagrams', async () => {
    const shared = await sharedDiagram();
    const owned = await createDiagram(BOB, "Bob's own");

    const sharedWithBob = await service.listSharedWithMe(BOB);
    const ownedByBob = await diagrams.listByOwner(BOB);

    expect(sharedWithBob.map((diagram) => diagram.id)).toEqual([shared]);
    expect(ownedByBob.map((diagram) => diagram.id)).toEqual([owned]);
  });

  it('does not include a diagram the identity owns', async () => {
    await createDiagram(ALICE);

    await expect(service.listSharedWithMe(ALICE)).resolves.toEqual([]);
  });

  it('stops including a diagram once access is removed', async () => {
    const id = await sharedDiagram();
    await service.remove(ALICE, id, BOB);

    await expect(service.listSharedWithMe(BOB)).resolves.toEqual([]);
  });

  it('answers an identity nobody has shared with as an empty list', async () => {
    await expect(service.listSharedWithMe(MALLORY)).resolves.toEqual([]);
  });

  it('orders by most recent activity', async () => {
    const first = await createDiagram(ALICE, 'First');
    const second = await createDiagram(ALICE, 'Second');
    await service.add(ALICE, first, { email: BOB }, clock);
    await service.add(ALICE, second, { email: BOB }, clock);

    // Touch the first so it sorts ahead of the second.
    await diagrams.updateMetadata(first, { title: 'First (renamed)' });

    await expect(service.listSharedWithMe(BOB)).resolves.toMatchObject([
      { id: first },
      { id: second }
    ]);
  });
});
