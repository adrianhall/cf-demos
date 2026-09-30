/**
 * @file Guards against drift between the migration SQL and the column lists the repositories select
 *   with. The projections in `src/worker/infrastructure/queries/tables.ts` are interpolated into
 *   SQL, while the matching `*Row` interfaces type the results. TypeScript cannot connect the two:
 *   if a migration renamed a column, the projection would still compile and the row type would
 *   still claim the field is a `string`, but every query would fail at runtime — or worse, quietly
 *   return `undefined` for a field the type system insists exists. These tests read the real table
 *   definitions out of a migrated D1 database and compare them against the declared lists, so that
 *   mismatch is caught here rather than in production.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  FILM_COLUMN_NAMES,
  PERSON_COLUMN_NAMES,
  PLANET_COLUMN_NAMES,
  SPECIES_COLUMN_NAMES,
  STARSHIP_COLUMN_NAMES,
  VEHICLE_COLUMN_NAMES
} from '../../src/worker/infrastructure/queries/tables';

/**
 * Declared column lists, keyed by the table each describes.
 */
const DECLARED: Record<string, readonly string[]> = {
  film: FILM_COLUMN_NAMES,
  person: PERSON_COLUMN_NAMES,
  planet: PLANET_COLUMN_NAMES,
  species: SPECIES_COLUMN_NAMES,
  starship: STARSHIP_COLUMN_NAMES,
  vehicle: VEHICLE_COLUMN_NAMES
};

/**
 * Join tables that must exist for the many-to-many relations to resolve.
 */
const JOIN_TABLES = [
  'film_person',
  'film_planet',
  'film_species',
  'film_starship',
  'film_vehicle',
  'person_starship',
  'person_vehicle'
];

/**
 * Read a table's actual column names from the migrated database.
 *
 * @param table Table to inspect.
 * @returns Its column names in declaration order.
 */
async function actualColumns(table: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`
  ).all<{ name: string }>();
  return result.results.map((row) => row.name);
}

describe('schema drift', () => {
  it.each(Object.keys(DECLARED))('%s declares exactly the columns it selects', async (table) => {
    // Compared as ordered lists, matching the documented convention that each `*Row` interface
    // mirrors the migration's column order.
    expect(await actualColumns(table)).toEqual([...DECLARED[table]]);
  });

  it.each(JOIN_TABLES)('%s exists with both of its foreign keys', async (table) => {
    const columns = await actualColumns(table);

    expect(columns).toHaveLength(2);
    for (const column of columns) {
      expect(column).toMatch(/_id$/u);
    }
  });

  it('keeps the nullable foreign keys nullable', async () => {
    // The GraphQL layer exposes `homeworld` and `species` as nullable fields precisely because
    // these columns allow NULL. A `NOT NULL` added here would make the seed fail instead.
    const result = await env.DB.prepare(
      "SELECT name, \"notnull\" FROM pragma_table_info('person') WHERE name IN ('homeworld_id', 'species_id')"
    ).all<{ name: string; notnull: number }>();

    expect(result.results).toHaveLength(2);
    for (const column of result.results) {
      expect(column.notnull, `${column.name} should be nullable`).toBe(0);
    }
  });
});

describe('seed data', () => {
  it('loads all six films', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM film').first<{
      count: number;
    }>();

    expect(row?.count).toBe(6);
  });

  it.each(['person', 'planet', 'species', 'starship', 'vehicle'])(
    'loads %s rows',
    async (table) => {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number;
      }>();

      expect(row?.count ?? 0).toBeGreaterThan(0);
    }
  );

  it.each(JOIN_TABLES)('loads %s relations', async (table) => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
      count: number;
    }>();

    expect(row?.count ?? 0).toBeGreaterThan(0);
  });

  it('leaves no dangling homeworld reference', async () => {
    // The seed resolves upstream URLs to local UUIDs. A mapping bug would show up as a foreign key
    // pointing at a planet that was never inserted, which would surface as an unexpectedly null
    // `homeworld` field rather than as an error.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM person
       WHERE homeworld_id IS NOT NULL
         AND homeworld_id NOT IN (SELECT id FROM planet)`
    ).first<{ count: number }>();

    expect(row?.count).toBe(0);
  });

  it('leaves no dangling species reference', async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM person
       WHERE species_id IS NOT NULL
         AND species_id NOT IN (SELECT id FROM species)`
    ).first<{ count: number }>();

    expect(row?.count).toBe(0);
  });

  it('assigns every entity a stable UUID primary key', async () => {
    // Identifiers are deterministic UUIDv5 values, so an identifier pasted into a saved query keeps
    // working across rebuilds. A sequential integer would break that.
    const row = await env.DB.prepare('SELECT id FROM film LIMIT 1').first<{ id: string }>();

    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });
});
