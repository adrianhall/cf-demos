import { COLUMNS } from "../tables/film";
import { placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit film projection reused by the static statements. */
const columns = COLUMNS.map((column) => `film.${column}`).join(", ");

/** Static SQL statements that return films without using `SELECT *`. */
export const FILM_QUERIES = {
  list: `SELECT ${columns} FROM film ORDER BY episode_id`,
  byId: `SELECT ${columns} FROM film WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM film WHERE id IN (${placeholders(count)})`,
  byPersonIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "film",
        join: "film_person",
        joinEntityColumn: "film_id",
        joinParentColumn: "person_id",
        orderBy: "film.episode_id, film.id",
      },
      count,
      first,
    ),
  byPlanetIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "film",
        join: "film_planet",
        joinEntityColumn: "film_id",
        joinParentColumn: "planet_id",
        orderBy: "film.episode_id, film.id",
      },
      count,
      first,
    ),
  bySpeciesIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "film",
        join: "film_species",
        joinEntityColumn: "film_id",
        joinParentColumn: "species_id",
        orderBy: "film.episode_id, film.id",
      },
      count,
      first,
    ),
  byStarshipIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "film",
        join: "film_starship",
        joinEntityColumn: "film_id",
        joinParentColumn: "starship_id",
        orderBy: "film.episode_id, film.id",
      },
      count,
      first,
    ),
  byVehicleIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "film",
        join: "film_vehicle",
        joinEntityColumn: "film_id",
        joinParentColumn: "vehicle_id",
        orderBy: "film.episode_id, film.id",
      },
      count,
      first,
    ),
} as const;
