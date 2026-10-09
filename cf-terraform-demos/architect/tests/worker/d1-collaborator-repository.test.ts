import { describe, expect, it } from 'vitest';
import { D1CollaboratorRepository } from '../../src/worker/infrastructure/d1-collaborator-repository.ts';
import { createFakeD1 } from './fake-d1.ts';

/**
 * @file Covers the D1 collaborator adapter's statements and row mapping. Like the diagram adapter's
 *   suite, this asserts what the adapter is responsible for — binding values as parameters, naming
 *   the right columns, and mapping D1's snake_case onto the domain shape — rather than whether the
 *   resulting access decision is correct, which is the service's job and is covered in
 *   `./collaborator-service.test.ts`. The SQL's _validity_ is proven in the Workers-runtime suite,
 *   which runs this adapter against a real migrated database.
 */

const DIAGRAM_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'alice@example.com';
const COLLABORATOR = 'bob@example.com';
const GRANTED_AT = '2026-02-01T00:00:00.000Z';

/**
 * A stored grant as D1 returns it, in snake_case.
 */
const STORED_GRANT = {
  added_at: GRANTED_AT,
  added_by: OWNER,
  collaborator_email: COLLABORATOR,
  diagram_id: DIAGRAM_ID,
  display_name: null
};

/**
 * The same grant in the domain vocabulary the adapter must produce.
 */
const MAPPED_GRANT = {
  addedAt: GRANTED_AT,
  addedBy: OWNER,
  collaboratorEmail: COLLABORATOR,
  diagramId: DIAGRAM_ID,
  displayName: null
};

describe('parameter binding', () => {
  // Every value reaches D1 as a bound parameter, never as interpolated SQL. Asserted rather than
  // reviewed, because the cost of getting it wrong is the whole table — and an email is a value a
  // caller supplies directly, unlike a diagram id, which has already been shape-checked.
  it('binds hostile values as parameters rather than interpolating them', async () => {
    const injection = "'; DROP TABLE diagram_collaborators; --";
    const fake = createFakeD1({ firstRows: [STORED_GRANT], changes: 1 });
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.add(injection, injection, injection, GRANTED_AT);
    await repository.remove(injection, injection);
    await repository.listForDiagram(injection);
    await repository.listSharedWith(injection);
    await repository.isCollaborator(injection, injection);

    expect(fake.statements).not.toHaveLength(0);
    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain('DROP TABLE');
      expect(statement.parameters).toContain(injection);
    }
  });
});

describe('adding a grant', () => {
  it('maps the returned row onto the domain shape', async () => {
    const fake = createFakeD1({ firstRows: [STORED_GRANT] });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.add(DIAGRAM_ID, COLLABORATOR, OWNER, GRANTED_AT)).resolves.toEqual(
      MAPPED_GRANT
    );
  });

  // One statement, not a read followed by a conditional insert: the composite key resolves the
  // conflict in place, and a read-then-write in the caller would race itself.
  it('resolves a repeat grant in a single statement', async () => {
    const fake = createFakeD1({ firstRows: [STORED_GRANT] });
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.add(DIAGRAM_ID, COLLABORATOR, OWNER, GRANTED_AT);

    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.sql).toContain('ON CONFLICT(diagram_id, collaborator_email)');
  });

  // `DO UPDATE SET added_by = added_by` rather than `DO NOTHING`, and the choice is load-bearing
  // twice over: `DO NOTHING` returns no row from `RETURNING`, which would force the second round
  // trip the single statement exists to avoid, and the self-assignment is what leaves the
  // original grant's author and timestamp untouched.
  it('returns the conflicting row without rewriting its audit trail', async () => {
    const fake = createFakeD1({ firstRows: [STORED_GRANT] });
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.add(DIAGRAM_ID, COLLABORATOR, 'someone-else@example.com', GRANTED_AT);

    const sql = fake.statements[0]?.sql ?? '';
    expect(sql).toContain('DO UPDATE SET added_by = added_by');
    expect(sql).not.toContain('DO NOTHING');
    expect(sql).toContain('RETURNING');
  });

  // An upsert either inserts or updates, so no row at all is a storage fault rather than an
  // outcome. Reporting it as "the grant did not stick" would tell an owner their grant failed
  // when what actually happened is that the database misbehaved.
  it('fails loudly when the upsert returns no row', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.add(DIAGRAM_ID, COLLABORATOR, OWNER, GRANTED_AT)).rejects.toThrow(
      /returned no row/u
    );
  });
});

describe('removing a grant', () => {
  it('reports a deleted row as removed', async () => {
    const fake = createFakeD1({ changes: 1 });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.remove(DIAGRAM_ID, COLLABORATOR)).resolves.toBe(true);
  });

  // The honest answer is what lets the service turn "nothing matched" into a `404` rather than
  // reporting a removal that never happened.
  it('reports no matching row as not removed', async () => {
    const fake = createFakeD1({ changes: 0 });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.remove(DIAGRAM_ID, COLLABORATOR)).resolves.toBe(false);
  });

  it('scopes the delete to the one pair, not the whole diagram', async () => {
    const fake = createFakeD1({ changes: 1 });
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.remove(DIAGRAM_ID, COLLABORATOR);

    expect(fake.statements[0]?.sql).toContain('WHERE diagram_id = ? AND collaborator_email = ?');
    expect(fake.statements[0]?.parameters).toEqual([DIAGRAM_ID, COLLABORATOR]);
  });
});

describe('listing a diagram\u2019s grants', () => {
  it('maps every row onto the domain shape', async () => {
    const fake = createFakeD1({ allRows: [STORED_GRANT] });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.listForDiagram(DIAGRAM_ID)).resolves.toEqual([MAPPED_GRANT]);
  });

  it('orders by when access was granted', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.listForDiagram(DIAGRAM_ID);

    expect(fake.statements[0]?.sql).toContain('ORDER BY c.added_at ASC');
  });

  // `displayName` is always null today, but the join keeps the documented response shape stable
  // for a deployment that later records names.
  it('joins the directory for the collaborator\u2019s display name', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.listForDiagram(DIAGRAM_ID);

    const sql = fake.statements[0]?.sql ?? '';
    expect(sql).toContain('u.display_name');
    expect(sql).toContain('JOIN users u ON u.email = c.collaborator_email');
  });

  it('answers a diagram with no grants as an empty list', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.listForDiagram(DIAGRAM_ID)).resolves.toEqual([]);
  });
});

describe('listing the diagrams shared with an identity', () => {
  it('maps the joined diagram rows onto the domain shape', async () => {
    const fake = createFakeD1({
      allRows: [
        {
          created_at: '2026-01-01T00:00:00.000Z',
          description: null,
          graph_data: '{}',
          id: DIAGRAM_ID,
          owner_email: OWNER,
          title: 'Shared',
          updated_at: '2026-01-02T00:00:00.000Z'
        }
      ]
    });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.listSharedWith(COLLABORATOR)).resolves.toEqual([
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        description: null,
        graphData: '{}',
        id: DIAGRAM_ID,
        ownerEmail: OWNER,
        title: 'Shared',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]);
  });

  // The owner's address is the one column this list needs that the owner's own list does not: it
  // is what the dashboard card says to distinguish somebody else's diagram from your own.
  it('selects the owner so a card can say who shared it', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.listSharedWith(COLLABORATOR);

    expect(fake.statements[0]?.sql).toContain('d.owner_email');
  });

  // An inner join, so a grant naming a diagram that no longer exists simply produces nothing.
  // This schema has no foreign keys, so such a row is possible if a delete ever failed halfway,
  // and the alternative would be a dashboard card pointing at nothing.
  it('joins the diagrams table rather than returning bare grant ids', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.listSharedWith(COLLABORATOR);

    const sql = fake.statements[0]?.sql ?? '';
    expect(sql).toContain('JOIN diagrams d ON d.id = c.diagram_id');
    expect(sql).toContain('ORDER BY d.updated_at DESC');
  });
});

describe('checking for a grant', () => {
  it('reports an existing grant', async () => {
    const fake = createFakeD1({ firstRows: [{ present: 1 }] });
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.isCollaborator(DIAGRAM_ID, COLLABORATOR)).resolves.toBe(true);
  });

  it('reports no grant', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await expect(repository.isCollaborator(DIAGRAM_ID, COLLABORATOR)).resolves.toBe(false);
  });

  // The hottest authorization path in the application: every read, graph save and live upgrade by
  // a non-owner runs it. Selecting a literal keeps it from reading columns it would discard.
  it('asks only whether a row exists', async () => {
    const fake = createFakeD1();
    const repository = new D1CollaboratorRepository(fake.database);

    await repository.isCollaborator(DIAGRAM_ID, COLLABORATOR);

    const sql = fake.statements[0]?.sql ?? '';
    expect(sql).toContain('SELECT 1');
    expect(sql).toContain('LIMIT 1');
  });
});
