import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

/**
 * Test-only bindings injected by the integration Vitest project (`./vitest.config.ts`).
 */
interface TestEnv extends Env {
  /**
   * Parsed D1 migrations used to build the schema and load the seed data into Miniflare's otherwise
   * empty database.
   */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Tables dropped before the schema is rebuilt, in an order that satisfies the foreign keys declared
 * in `migrations/0001_create_swapi_schema.sql`: join tables first, then entities that reference
 * others, then the tables they point at. This is the reverse of the order the seed migrations
 * populate them in.
 */
const TABLES = [
  'film_person',
  'film_planet',
  'film_species',
  'film_starship',
  'film_vehicle',
  'person_starship',
  'person_vehicle',
  'person',
  'species',
  'starship',
  'vehicle',
  'planet',
  'film'
];

/**
 * Build the schema and load the seed data once per suite.
 *
 * The explicit drop makes the run idempotent. `applyD1Migrations` tracks which migrations it has
 * applied, so against a database that already has them it would do nothing — fine on a clean
 * in-memory database, but it would silently skip rebuilding if state ever persisted between runs
 * within a worker. Dropping first means each suite starts from a known-empty database and proves
 * the migrations can build it from scratch.
 *
 * `applyD1Migrations` runs all four real committed migration files, including the three literal
 * seed files. These tests therefore assert against the same rows the deployed API serves, and a
 * malformed seed statement fails here rather than during a deploy. Applying them in sequence also
 * exercises the foreign-key dependency order the seed is split along: a group emitted before the
 * rows it references would fail here with a constraint violation.
 */
beforeAll(async () => {
  const testEnv = env as TestEnv;

  await testEnv.DB.batch(
    TABLES.map((table) => testEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`))
  );
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
