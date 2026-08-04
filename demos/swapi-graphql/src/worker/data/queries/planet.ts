import { COLUMNS } from "../tables/planet";

/** Comma-delimited explicit planet projection reused by the static statements. */
const columns = COLUMNS.map((column) => `planet.${column}`).join(", ");

/** Static SQL statements that return planets without using `SELECT *`. */
export const PLANET_QUERIES = {
  list: `SELECT ${columns} FROM planet ORDER BY name`,
  byId: `SELECT ${columns} FROM planet WHERE id = ?`,
  byFilmId: `SELECT ${columns} FROM planet INNER JOIN film_planet ON film_planet.planet_id = planet.id WHERE film_planet.film_id = ? ORDER BY planet.name`,
  byPersonId: `SELECT ${columns} FROM planet INNER JOIN person ON person.homeworld_id = planet.id WHERE person.id = ?`,
  bySpeciesId: `SELECT ${columns} FROM planet INNER JOIN species ON species.homeworld_id = planet.id WHERE species.id = ?`,
} as const;
