/**
 * @file Every SQL statement this application runs, grouped by the table it reads. Collecting them
 *   here rather than inlining them in the repositories means the complete set of queries the Worker
 *   can issue is reviewable in one file, and the repositories below read as a list of which
 *   statement each port method uses. `list` and `byId`-style statements are plain constants.
 *   Anything batched is a function, because its placeholder count depends on the batch size — see
 *   `./sql.ts` for why that is safe. Ordering is specified on every statement, and matches the
 *   order each port documents. Relation queries sort by the parent key first so rows arrive already
 *   grouped, then by a stable tiebreaker (`name, id` or `episode_id, id`) so that entities with
 *   duplicate names still come back in a deterministic order.
 */

import { foreignKeyRelationQuery, joinRelationQuery, placeholders } from './sql';
import {
  FILM_COLUMNS,
  PERSON_COLUMNS,
  PLANET_COLUMNS,
  SPECIES_COLUMNS,
  STARSHIP_COLUMNS,
  VEHICLE_COLUMNS
} from './tables';

/**
 * Statements reading the `film` table.
 */
export const FILM_STATEMENTS = {
  /**
   * Every film in saga order.
   */
  list: `SELECT ${FILM_COLUMNS} FROM film ORDER BY film.episode_id`,

  /**
   * Films by primary key.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${FILM_COLUMNS} FROM film WHERE film.id IN (${placeholders(count)})`,

  /**
   * Films grouped by the characters appearing in them.
   *
   * @param count Number of character identifiers to bind.
   * @param limit Optional per-character film limit.
   * @returns The statement text.
   */
  byPersonIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: FILM_COLUMNS,
        entity: 'film',
        join: 'film_person',
        joinEntityColumn: 'film_id',
        joinParentColumn: 'person_id',
        orderBy: 'film.episode_id, film.id'
      },
      count,
      limit
    ),

  /**
   * Films grouped by the planets appearing in them.
   *
   * @param count Number of planet identifiers to bind.
   * @param limit Optional per-planet film limit.
   * @returns The statement text.
   */
  byPlanetIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: FILM_COLUMNS,
        entity: 'film',
        join: 'film_planet',
        joinEntityColumn: 'film_id',
        joinParentColumn: 'planet_id',
        orderBy: 'film.episode_id, film.id'
      },
      count,
      limit
    ),

  /**
   * Films grouped by the species appearing in them.
   *
   * @param count Number of species identifiers to bind.
   * @param limit Optional per-species film limit.
   * @returns The statement text.
   */
  bySpeciesIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: FILM_COLUMNS,
        entity: 'film',
        join: 'film_species',
        joinEntityColumn: 'film_id',
        joinParentColumn: 'species_id',
        orderBy: 'film.episode_id, film.id'
      },
      count,
      limit
    ),

  /**
   * Films grouped by the starships appearing in them.
   *
   * @param count Number of starship identifiers to bind.
   * @param limit Optional per-starship film limit.
   * @returns The statement text.
   */
  byStarshipIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: FILM_COLUMNS,
        entity: 'film',
        join: 'film_starship',
        joinEntityColumn: 'film_id',
        joinParentColumn: 'starship_id',
        orderBy: 'film.episode_id, film.id'
      },
      count,
      limit
    ),

  /**
   * Films grouped by the vehicles appearing in them.
   *
   * @param count Number of vehicle identifiers to bind.
   * @param limit Optional per-vehicle film limit.
   * @returns The statement text.
   */
  byVehicleIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: FILM_COLUMNS,
        entity: 'film',
        join: 'film_vehicle',
        joinEntityColumn: 'film_id',
        joinParentColumn: 'vehicle_id',
        orderBy: 'film.episode_id, film.id'
      },
      count,
      limit
    )
} as const;

/**
 * Statements reading the `person` table.
 */
export const PERSON_STATEMENTS = {
  /**
   * Every character by name.
   */
  list: `SELECT ${PERSON_COLUMNS} FROM person ORDER BY person.name, person.id`,

  /**
   * Characters by primary key.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${PERSON_COLUMNS} FROM person WHERE person.id IN (${placeholders(count)})`,

  /**
   * Characters grouped by the films they appear in.
   *
   * @param count Number of film identifiers to bind.
   * @param limit Optional per-film character limit.
   * @returns The statement text.
   */
  byFilmIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: PERSON_COLUMNS,
        entity: 'person',
        join: 'film_person',
        joinEntityColumn: 'person_id',
        joinParentColumn: 'film_id',
        orderBy: 'person.name, person.id'
      },
      count,
      limit
    ),

  /**
   * Characters grouped by their home planet. Resolved through the `homeworld_id` foreign key rather
   * than a join table, because a character has at most one homeworld.
   *
   * @param count Number of planet identifiers to bind.
   * @param limit Optional per-planet resident limit.
   * @returns The statement text.
   */
  byPlanetIds: (count: number, limit?: number): string =>
    foreignKeyRelationQuery(
      {
        columns: PERSON_COLUMNS,
        entity: 'person',
        parentColumn: 'homeworld_id',
        orderBy: 'person.name, person.id'
      },
      count,
      limit
    ),

  /**
   * Characters grouped by their species, also a foreign-key relation.
   *
   * @param count Number of species identifiers to bind.
   * @param limit Optional per-species member limit.
   * @returns The statement text.
   */
  bySpeciesIds: (count: number, limit?: number): string =>
    foreignKeyRelationQuery(
      {
        columns: PERSON_COLUMNS,
        entity: 'person',
        parentColumn: 'species_id',
        orderBy: 'person.name, person.id'
      },
      count,
      limit
    ),

  /**
   * Characters grouped by the starships they pilot.
   *
   * @param count Number of starship identifiers to bind.
   * @param limit Optional per-starship pilot limit.
   * @returns The statement text.
   */
  byStarshipIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: PERSON_COLUMNS,
        entity: 'person',
        join: 'person_starship',
        joinEntityColumn: 'person_id',
        joinParentColumn: 'starship_id',
        orderBy: 'person.name, person.id'
      },
      count,
      limit
    ),

  /**
   * Characters grouped by the vehicles they pilot.
   *
   * @param count Number of vehicle identifiers to bind.
   * @param limit Optional per-vehicle pilot limit.
   * @returns The statement text.
   */
  byVehicleIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: PERSON_COLUMNS,
        entity: 'person',
        join: 'person_vehicle',
        joinEntityColumn: 'person_id',
        joinParentColumn: 'vehicle_id',
        orderBy: 'person.name, person.id'
      },
      count,
      limit
    )
} as const;

/**
 * Statements reading the `planet` table.
 */
export const PLANET_STATEMENTS = {
  /**
   * Every planet by name.
   */
  list: `SELECT ${PLANET_COLUMNS} FROM planet ORDER BY planet.name, planet.id`,

  /**
   * Planets by primary key. Also serves the `homeworld` field on characters and species.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${PLANET_COLUMNS} FROM planet WHERE planet.id IN (${placeholders(count)})`,

  /**
   * Planets grouped by the films they appear in.
   *
   * @param count Number of film identifiers to bind.
   * @param limit Optional per-film planet limit.
   * @returns The statement text.
   */
  byFilmIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: PLANET_COLUMNS,
        entity: 'planet',
        join: 'film_planet',
        joinEntityColumn: 'planet_id',
        joinParentColumn: 'film_id',
        orderBy: 'planet.name, planet.id'
      },
      count,
      limit
    )
} as const;

/**
 * Statements reading the `species` table.
 */
export const SPECIES_STATEMENTS = {
  /**
   * Every species by name.
   */
  list: `SELECT ${SPECIES_COLUMNS} FROM species ORDER BY species.name, species.id`,

  /**
   * Species by primary key. Also serves the `species` field on a character.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${SPECIES_COLUMNS} FROM species WHERE species.id IN (${placeholders(count)})`,

  /**
   * Species grouped by the films they appear in.
   *
   * @param count Number of film identifiers to bind.
   * @param limit Optional per-film species limit.
   * @returns The statement text.
   */
  byFilmIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: SPECIES_COLUMNS,
        entity: 'species',
        join: 'film_species',
        joinEntityColumn: 'species_id',
        joinParentColumn: 'film_id',
        orderBy: 'species.name, species.id'
      },
      count,
      limit
    )
} as const;

/**
 * Statements reading the `starship` table.
 */
export const STARSHIP_STATEMENTS = {
  /**
   * Every starship by name.
   */
  list: `SELECT ${STARSHIP_COLUMNS} FROM starship ORDER BY starship.name, starship.id`,

  /**
   * Starships by primary key.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${STARSHIP_COLUMNS} FROM starship WHERE starship.id IN (${placeholders(count)})`,

  /**
   * Starships grouped by the films they appear in.
   *
   * @param count Number of film identifiers to bind.
   * @param limit Optional per-film starship limit.
   * @returns The statement text.
   */
  byFilmIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: STARSHIP_COLUMNS,
        entity: 'starship',
        join: 'film_starship',
        joinEntityColumn: 'starship_id',
        joinParentColumn: 'film_id',
        orderBy: 'starship.name, starship.id'
      },
      count,
      limit
    ),

  /**
   * Starships grouped by the characters who pilot them.
   *
   * @param count Number of character identifiers to bind.
   * @param limit Optional per-character starship limit.
   * @returns The statement text.
   */
  byPersonIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: STARSHIP_COLUMNS,
        entity: 'starship',
        join: 'person_starship',
        joinEntityColumn: 'starship_id',
        joinParentColumn: 'person_id',
        orderBy: 'starship.name, starship.id'
      },
      count,
      limit
    )
} as const;

/**
 * Statements reading the `vehicle` table.
 */
export const VEHICLE_STATEMENTS = {
  /**
   * Every vehicle by name.
   */
  list: `SELECT ${VEHICLE_COLUMNS} FROM vehicle ORDER BY vehicle.name, vehicle.id`,

  /**
   * Vehicles by primary key.
   *
   * @param count Number of identifiers to bind.
   * @returns The statement text.
   * @throws {RangeError} When `count` exceeds D1's parameter limit.
   */
  byIds: (count: number): string =>
    `SELECT ${VEHICLE_COLUMNS} FROM vehicle WHERE vehicle.id IN (${placeholders(count)})`,

  /**
   * Vehicles grouped by the films they appear in.
   *
   * @param count Number of film identifiers to bind.
   * @param limit Optional per-film vehicle limit.
   * @returns The statement text.
   */
  byFilmIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: VEHICLE_COLUMNS,
        entity: 'vehicle',
        join: 'film_vehicle',
        joinEntityColumn: 'vehicle_id',
        joinParentColumn: 'film_id',
        orderBy: 'vehicle.name, vehicle.id'
      },
      count,
      limit
    ),

  /**
   * Vehicles grouped by the characters who pilot them.
   *
   * @param count Number of character identifiers to bind.
   * @param limit Optional per-character vehicle limit.
   * @returns The statement text.
   */
  byPersonIds: (count: number, limit?: number): string =>
    joinRelationQuery(
      {
        columns: VEHICLE_COLUMNS,
        entity: 'vehicle',
        join: 'person_vehicle',
        joinEntityColumn: 'vehicle_id',
        joinParentColumn: 'person_id',
        orderBy: 'vehicle.name, vehicle.id'
      },
      count,
      limit
    )
} as const;
