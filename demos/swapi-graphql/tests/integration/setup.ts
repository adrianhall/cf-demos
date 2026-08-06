import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

/** Test-only bindings added by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed migration files loaded from the demo's committed migration directory. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Tables are dropped in dependency order before every integration suite rebuild. */
const TABLES_TO_DROP = [
  "film_person",
  "film_planet",
  "film_species",
  "film_starship",
  "film_vehicle",
  "person_starship",
  "person_vehicle",
  "person",
  "species",
  "starship",
  "vehicle",
  "planet",
  "film",
];

beforeAll(async () => {
  const testEnv = env as TestEnv;
  await testEnv.DB.batch(
    TABLES_TO_DROP.map((table) =>
      testEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`),
    ),
  );
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
