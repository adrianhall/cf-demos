import { COLUMNS } from "../tables/planet";
import { placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit planet projection reused by the static statements. */
const columns = COLUMNS.map((column) => `planet.${column}`).join(", ");

/** Static SQL statements that return planets without using `SELECT *`. */
export const PLANET_QUERIES = {
  list: `SELECT ${columns} FROM planet ORDER BY name`,
  byId: `SELECT ${columns} FROM planet WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM planet WHERE id IN (${placeholders(count)})`,
  byFilmIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "planet",
        join: "film_planet",
        joinEntityColumn: "planet_id",
        joinParentColumn: "film_id",
        orderBy: "planet.name, planet.id",
      },
      count,
      first,
    ),
} as const;
