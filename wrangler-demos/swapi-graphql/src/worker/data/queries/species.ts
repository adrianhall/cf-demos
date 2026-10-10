import { COLUMNS } from "../tables/species";
import { placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit species projection reused by the static statements. */
const columns = COLUMNS.map((column) => `species.${column}`).join(", ");

/** Static SQL statements that return species without using `SELECT *`. */
export const SPECIES_QUERIES = {
  list: `SELECT ${columns} FROM species ORDER BY name`,
  byId: `SELECT ${columns} FROM species WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM species WHERE id IN (${placeholders(count)})`,
  byFilmIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "species",
        join: "film_species",
        joinEntityColumn: "species_id",
        joinParentColumn: "film_id",
        orderBy: "species.name, species.id",
      },
      count,
      first,
    ),
} as const;
