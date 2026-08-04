import { COLUMNS } from "../tables/species";

/** Comma-delimited explicit species projection reused by the static statements. */
const columns = COLUMNS.map((column) => `species.${column}`).join(", ");

/** Static SQL statements that return species without using `SELECT *`. */
export const SPECIES_QUERIES = {
  list: `SELECT ${columns} FROM species ORDER BY name`,
  byId: `SELECT ${columns} FROM species WHERE id = ?`,
  byFilmId: `SELECT ${columns} FROM species INNER JOIN film_species ON film_species.species_id = species.id WHERE film_species.film_id = ? ORDER BY species.name`,
  byPersonId: `SELECT ${columns} FROM species INNER JOIN person ON person.species_id = species.id WHERE person.id = ?`,
} as const;
