import { COLUMNS } from "../tables/vehicle";

/** Comma-delimited explicit vehicle projection reused by the static statements. */
const columns = COLUMNS.join(", ");

/** Static SQL statements that return vehicles without using `SELECT *`. */
export const VEHICLE_QUERIES = {
  list: `SELECT ${columns} FROM vehicle ORDER BY name`,
  byId: `SELECT ${columns} FROM vehicle WHERE id = ?`,
  byFilmId: `SELECT ${columns} FROM vehicle INNER JOIN film_vehicle ON film_vehicle.vehicle_id = vehicle.id WHERE film_vehicle.film_id = ? ORDER BY vehicle.name`,
  byPersonId: `SELECT ${columns} FROM vehicle INNER JOIN person_vehicle ON person_vehicle.vehicle_id = vehicle.id WHERE person_vehicle.person_id = ? ORDER BY vehicle.name`,
} as const;
