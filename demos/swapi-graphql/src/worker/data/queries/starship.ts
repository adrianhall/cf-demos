import { COLUMNS } from "../tables/starship";

/** Comma-delimited explicit starship projection reused by the static statements. */
const columns = COLUMNS.map((column) => `starship.${column}`).join(", ");

/** Static SQL statements that return starships without using `SELECT *`. */
export const STARSHIP_QUERIES = {
  list: `SELECT ${columns} FROM starship ORDER BY name`,
  byId: `SELECT ${columns} FROM starship WHERE id = ?`,
  byFilmId: `SELECT ${columns} FROM starship INNER JOIN film_starship ON film_starship.starship_id = starship.id WHERE film_starship.film_id = ? ORDER BY starship.name`,
  byPersonId: `SELECT ${columns} FROM starship INNER JOIN person_starship ON person_starship.starship_id = starship.id WHERE person_starship.person_id = ? ORDER BY starship.name`,
} as const;
