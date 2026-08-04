import { COLUMNS } from "../tables/film";

/** Comma-delimited explicit film projection reused by the static statements. */
const columns = COLUMNS.join(", ");

/** Static SQL statements that return films without using `SELECT *`. */
export const FILM_QUERIES = {
  list: `SELECT ${columns} FROM film ORDER BY episode_id`,
  byId: `SELECT ${columns} FROM film WHERE id = ?`,
  byPersonId: `SELECT ${columns} FROM film INNER JOIN film_person ON film_person.film_id = film.id WHERE film_person.person_id = ? ORDER BY film.episode_id`,
  byPlanetId: `SELECT ${columns} FROM film INNER JOIN film_planet ON film_planet.film_id = film.id WHERE film_planet.planet_id = ? ORDER BY film.episode_id`,
  bySpeciesId: `SELECT ${columns} FROM film INNER JOIN film_species ON film_species.film_id = film.id WHERE film_species.species_id = ? ORDER BY film.episode_id`,
  byStarshipId: `SELECT ${columns} FROM film INNER JOIN film_starship ON film_starship.film_id = film.id WHERE film_starship.starship_id = ? ORDER BY film.episode_id`,
  byVehicleId: `SELECT ${columns} FROM film INNER JOIN film_vehicle ON film_vehicle.film_id = film.id WHERE film_vehicle.vehicle_id = ? ORDER BY film.episode_id`,
} as const;
