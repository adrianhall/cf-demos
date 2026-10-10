import { COLUMNS } from "../tables/starship";
import { placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit starship projection reused by the static statements. */
const columns = COLUMNS.map((column) => `starship.${column}`).join(", ");

/** Static SQL statements that return starships without using `SELECT *`. */
export const STARSHIP_QUERIES = {
  list: `SELECT ${columns} FROM starship ORDER BY name`,
  byId: `SELECT ${columns} FROM starship WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM starship WHERE id IN (${placeholders(count)})`,
  byFilmIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "starship",
        join: "film_starship",
        joinEntityColumn: "starship_id",
        joinParentColumn: "film_id",
        orderBy: "starship.name, starship.id",
      },
      count,
      first,
    ),
  byPersonIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "starship",
        join: "person_starship",
        joinEntityColumn: "starship_id",
        joinParentColumn: "person_id",
        orderBy: "starship.name, starship.id",
      },
      count,
      first,
    ),
} as const;
