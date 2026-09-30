import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  D1_MAX_BOUND_PARAMETERS,
  RELATION_BATCH_SIZE,
  foreignKeyRelationQuery,
  joinRelationQuery,
  placeholders
} from '../../../src/worker/infrastructure/queries/sql';

/**
 * Fragments describing a film's characters, used to exercise the join-table builder.
 */
const joinShape = {
  columns: 'person.id, person.name',
  entity: 'person',
  join: 'film_person',
  joinEntityColumn: 'person_id',
  joinParentColumn: 'film_id',
  orderBy: 'person.name, person.id'
};

/**
 * Fragments describing a planet's residents, used to exercise the foreign-key builder.
 */
const foreignKeyShape = {
  columns: 'person.id, person.name',
  entity: 'person',
  parentColumn: 'homeworld_id',
  orderBy: 'person.name, person.id'
};

describe('placeholders', () => {
  it('generates one placeholder per parameter', () => {
    expect(placeholders(1)).toBe('?');
    expect(placeholders(3)).toBe('?, ?, ?');
  });

  it('generates placeholders up to D1 limit', () => {
    expect(placeholders(D1_MAX_BOUND_PARAMETERS).split(', ')).toHaveLength(D1_MAX_BOUND_PARAMETERS);
  });

  it.each([
    ['an empty batch', 0],
    ['a negative count', -1],
    ['a batch beyond D1 limit', D1_MAX_BOUND_PARAMETERS + 1]
  ])('rejects %s', (_label, count) => {
    // Failing here rather than at execution time means the error names the real constraint instead
    // of surfacing as an opaque D1 rejection.
    expect(() => placeholders(count)).toThrow(RangeError);
  });

  it('keeps the relation batch size within D1 parameter limit, with room for a limit value', () => {
    // This is the invariant that makes a limited relation query expressible at all: the batch's
    // identifiers plus the trailing limit parameter must still fit in one statement.
    expect(RELATION_BATCH_SIZE).toBeLessThan(D1_MAX_BOUND_PARAMETERS);
  });
});

describe('migration files', () => {
  /**
   * Upper bound on one migration file's size.
   *
   * D1 applies a migration as a single unit and refuses an oversized one — locally with `statement
   * too long: SQLITE_TOOBIG` even when no individual statement is close to the limit. The seed is
   * therefore split across three files by foreign-key dependency order. This mirrors
   * `MAX_MIGRATION_BYTES` in `scripts/generate-seed-migration.ts`; the generator enforces it when
   * writing, and this asserts it for what is actually committed.
   */
  const MAX_MIGRATION_BYTES = 60_000;

  it('keeps every committed migration applicable by D1', async () => {
    const directory = path.resolve(import.meta.dirname, '../../../migrations');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql'));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const { size } = await stat(path.join(directory, file));
      expect(size, `${file} would be rejected by D1`).toBeLessThanOrEqual(MAX_MIGRATION_BYTES);
    }
  });
});

describe('joinRelationQuery', () => {
  it('projects the parent key so a flat result can be regrouped per parent', () => {
    const sql = joinRelationQuery(joinShape, 2);
    expect(sql).toContain('film_person.film_id AS parent_id');
  });

  it('binds one placeholder per parent and joins through the join table', () => {
    const sql = joinRelationQuery(joinShape, 3);
    expect(sql).toContain('WHERE film_person.film_id IN (?, ?, ?)');
    expect(sql).toContain('INNER JOIN film_person ON film_person.person_id = person.id');
  });

  it('orders by the parent key first, so rows arrive already grouped', () => {
    const sql = joinRelationQuery(joinShape, 2);
    expect(sql).toContain('ORDER BY film_person.film_id, person.name, person.id');
  });

  it('uses no window function when no limit is requested', () => {
    // The simpler statement is not just tidier: it avoids materialising a derived table for the
    // common case where the caller wants every child.
    expect(joinRelationQuery(joinShape, 2)).not.toContain('ROW_NUMBER');
  });

  it('limits per parent rather than across the whole result', () => {
    const sql = joinRelationQuery(joinShape, 2, 5);
    // PARTITION BY is the entire point: a plain LIMIT would return five rows in total, almost
    // certainly all belonging to the first film, instead of five characters for each film.
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY film_person.film_id');
    expect(sql).toContain('WHERE row_number <= ?');
  });

  it('unqualifies the outer projection, since the subquery table is out of scope', () => {
    const sql = joinRelationQuery(joinShape, 2, 5);
    expect(sql).toMatch(/^SELECT parent_id, id, name FROM \(/u);
    expect(sql).toMatch(/ORDER BY parent_id, name, id$/u);
  });

  it('rejects a batch larger than D1 can bind', () => {
    expect(() => joinRelationQuery(joinShape, D1_MAX_BOUND_PARAMETERS + 1)).toThrow(RangeError);
  });
});

describe('foreignKeyRelationQuery', () => {
  it('reads the parent key from the child row without a join table', () => {
    const sql = foreignKeyRelationQuery(foreignKeyShape, 2);
    expect(sql).toContain('person.homeworld_id AS parent_id');
    expect(sql).not.toContain('INNER JOIN');
  });

  it('binds one placeholder per parent', () => {
    expect(foreignKeyRelationQuery(foreignKeyShape, 3)).toContain(
      'WHERE person.homeworld_id IN (?, ?, ?)'
    );
  });

  it('orders by the parent key first, so rows arrive already grouped', () => {
    expect(foreignKeyRelationQuery(foreignKeyShape, 2)).toContain(
      'ORDER BY person.homeworld_id, person.name, person.id'
    );
  });

  it('limits per parent rather than across the whole result', () => {
    const sql = foreignKeyRelationQuery(foreignKeyShape, 2, 5);
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY person.homeworld_id');
    expect(sql).toContain('WHERE row_number <= ?');
  });

  it('rejects a batch larger than D1 can bind', () => {
    expect(() => foreignKeyRelationQuery(foreignKeyShape, D1_MAX_BOUND_PARAMETERS + 1)).toThrow(
      RangeError
    );
  });
});
