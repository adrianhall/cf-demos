import { COLUMNS } from "../tables/person";

/** Comma-delimited explicit person projection reused by the static statements. */
const columns = COLUMNS.map((column) => `person.${column}`).join(", ");

/** Static SQL statements that return people without using `SELECT *`. */
export const PERSON_QUERIES = {
  list: `SELECT ${columns} FROM person ORDER BY name`,
  byId: `SELECT ${columns} FROM person WHERE id = ?`,
  byFilmId: `SELECT ${columns} FROM person INNER JOIN film_person ON film_person.person_id = person.id WHERE film_person.film_id = ? ORDER BY person.name`,
  byPlanetId: `SELECT ${columns} FROM person WHERE homeworld_id = ? ORDER BY name`,
  bySpeciesId: `SELECT ${columns} FROM person WHERE species_id = ? ORDER BY name`,
  byStarshipId: `SELECT ${columns} FROM person INNER JOIN person_starship ON person_starship.person_id = person.id WHERE person_starship.starship_id = ? ORDER BY person.name`,
  byVehicleId: `SELECT ${columns} FROM person INNER JOIN person_vehicle ON person_vehicle.person_id = person.id WHERE person_vehicle.vehicle_id = ? ORDER BY person.name`,
} as const;
