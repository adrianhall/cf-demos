import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Expected ordered columns for every table created by the initial schema migration. */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  film: [
    "id",
    "episode_id",
    "title",
    "opening_crawl",
    "director",
    "producer",
    "release_date",
    "created",
    "edited",
    "url",
  ],
  planet: [
    "id",
    "name",
    "rotation_period",
    "orbital_period",
    "diameter",
    "climate",
    "gravity",
    "terrain",
    "surface_water",
    "population",
    "created",
    "edited",
    "url",
  ],
  species: [
    "id",
    "name",
    "classification",
    "designation",
    "average_height",
    "skin_colors",
    "hair_colors",
    "eye_colors",
    "average_lifespan",
    "homeworld_id",
    "language",
    "created",
    "edited",
    "url",
  ],
  person: [
    "id",
    "name",
    "height",
    "mass",
    "hair_color",
    "skin_color",
    "eye_color",
    "birth_year",
    "gender",
    "homeworld_id",
    "species_id",
    "created",
    "edited",
    "url",
  ],
  starship: [
    "id",
    "name",
    "model",
    "manufacturer",
    "cost_in_credits",
    "length",
    "max_atmosphering_speed",
    "crew",
    "passengers",
    "cargo_capacity",
    "consumables",
    "hyperdrive_rating",
    "mglt",
    "starship_class",
    "created",
    "edited",
    "url",
  ],
  vehicle: [
    "id",
    "name",
    "model",
    "manufacturer",
    "cost_in_credits",
    "length",
    "max_atmosphering_speed",
    "crew",
    "passengers",
    "cargo_capacity",
    "consumables",
    "vehicle_class",
    "created",
    "edited",
    "url",
  ],
  film_person: ["film_id", "person_id"],
  film_planet: ["film_id", "planet_id"],
  film_species: ["film_id", "species_id"],
  film_starship: ["film_id", "starship_id"],
  film_vehicle: ["film_id", "vehicle_id"],
  person_starship: ["person_id", "starship_id"],
  person_vehicle: ["person_id", "vehicle_id"],
};

/** Reverse indexes required to make each intentional per-parent join lookup efficient. */
const REVERSE_INDEXES: Record<string, string> = {
  film_person: "idx_film_person_reverse",
  film_planet: "idx_film_planet_reverse",
  film_species: "idx_film_species_reverse",
  film_starship: "idx_film_starship_reverse",
  film_vehicle: "idx_film_vehicle_reverse",
  person_starship: "idx_person_starship_reverse",
  person_vehicle: "idx_person_vehicle_reverse",
};

describe("D1 schema drift", () => {
  it.each(Object.entries(EXPECTED_COLUMNS))(
    "keeps %s columns in migration order",
    async (table, columns) => {
      const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>();
      expect(result.results.map((column) => column.name)).toEqual(columns);
    },
  );

  it.each(Object.entries(REVERSE_INDEXES))(
    "keeps %s reverse lookup index",
    async (table, index) => {
      const result = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{
        name: string;
      }>();
      expect(result.results.map((entry) => entry.name)).toContain(index);
    },
  );
});
