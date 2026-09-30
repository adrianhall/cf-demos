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

import {
  foreignKeyRelationQuery,
  joinRelationQuery,
  placeholders,
  searchCondition,
  searchPattern
} from './sql';
import {
  FILM_COLUMNS,
  PERSON_COLUMNS,
  PLANET_COLUMNS,
  SPECIES_COLUMNS,
  STARSHIP_COLUMNS,
  VEHICLE_COLUMNS
} from './tables';

/**
 * A statement together with the parameters to bind to it.
 *
 * List statements return this pair rather than bare text because the number of parameters a
 * filtered list binds is derived from its searchable columns: the same pattern is bound once per
 * column. Returning the two separately would leave the repository to recompute that count and to
 * agree with this file about it — precisely the kind of duplicated knowledge that produces a
 * `D1_ERROR: Wrong number of parameter bindings` the first time a column is added to a search list.
 * Here the two are constructed together and cannot disagree.
 */
export interface BoundStatement {
  /**
   * Statement text, containing a `?` for every entry in {@link BoundStatement.bindings}.
   */
  sql: string;
  /**
   * Values to bind, in placeholder order. Empty for an unfiltered list.
   */
  bindings: readonly string[];
}

/**
 * Build a collection's list statement and its bindings, optionally filtered by a search term.
 *
 * Every collection has the same shape — project the columns, optionally filter, order — so the six
 * `list` statements below are built from this one function rather than written out six times. The
 * per-table differences are the projection, the ordering, and which columns a search matches.
 *
 * The statement is built with or without its `WHERE` clause rather than always emitting one with a
 * `%%` pattern. An unfiltered list is by far the common case — it is what the collection column
 * loads on every navigation — and a statement that does not mention `LIKE` at all is both cheaper
 * and easier to recognise in a query log.
 *
 * @param table Table to read, for example `person`. Source-controlled text, never request data.
 * @param columns Qualified projection for that table, from `./tables.ts`.
 * @param orderBy Qualified ordering fragment, matching the order the port documents.
 * @param searchColumns Qualified columns a search term matches against. Chosen per table to be the
 *   fields a person would search by — never `created`, `edited`, `url`, or `id`, which are
 *   provenance rather than content and produce matches a user cannot explain.
 * @param search Validated, trimmed search term from `validateSearchTerm`, or `undefined` for an
 *   unfiltered list. The term is only ever bound as a parameter; it never reaches the text.
 * @returns The statement and the pattern to bind, repeated once per searched column.
 */
function listQuery(
  table: string,
  columns: string,
  orderBy: string,
  searchColumns: readonly string[],
  search: string | undefined
): BoundStatement {
  if (search === undefined) {
    return { sql: `SELECT ${columns} FROM ${table} ORDER BY ${orderBy}`, bindings: [] };
  }

  const pattern = searchPattern(search);
  return {
    sql:
      `SELECT ${columns} FROM ${table} WHERE ${searchCondition(searchColumns)} `
      + `ORDER BY ${orderBy}`,
    bindings: searchColumns.map(() => pattern)
  };
}

// ## Which columns each collection searches
//
// Collected here rather than spread through the statements below, because the set of searchable
// columns is a product decision that should be reviewable in one place: it determines what a user
// can and cannot find, and a field added to the wrong list produces matches nobody can account
// for.
//
// Two rules govern every list. First, *provenance is never searchable* — `id`, `url`, `created`,
// and `edited` describe the record rather than its subject, so matching them returns rows for
// reasons invisible in the result. Second, a column earns its place only if a user would plausibly
// type it into a search box expecting *these* rows back.

/**
 * Film columns a search term matches against.
 */
const FILM_SEARCH_COLUMNS = ['film.title', 'film.director'] as const;

/**
 * Character columns a search term matches against.
 *
 * Name only. A character has no other field anyone searches by: `birth_year` and the colour fields
 * are attributes you filter on once you have found someone, not ways of finding them.
 */
const PERSON_SEARCH_COLUMNS = ['person.name'] as const;

/**
 * Planet columns a search term matches against.
 *
 * Name, plus `climate` and `terrain` — "desert" is a genuinely useful way to look for a planet, and
 * those two fields are short controlled vocabularies rather than free prose, so a match is
 * self-evident from the row.
 */
const PLANET_SEARCH_COLUMNS = ['planet.name', 'planet.climate', 'planet.terrain'] as const;

/**
 * Species columns a search term matches against.
 *
 * Name, plus `classification` and `designation` ("mammal", "sentient"), which are how the dataset
 * groups species and therefore how someone browses them.
 */
const SPECIES_SEARCH_COLUMNS = [
  'species.name',
  'species.classification',
  'species.designation'
] as const;

/**
 * Starship columns a search term matches against.
 *
 * Craft are known by several names at once: the familiar one (`X-wing`), the formal model (`T-65
 * X-wing`), who built it, and its class. Searching only `name` would fail to find a ship by its
 * model designation, which is exactly how a reader of the dataset is most likely to know it.
 */
const STARSHIP_SEARCH_COLUMNS = [
  'starship.name',
  'starship.model',
  'starship.manufacturer',
  'starship.starship_class'
] as const;

/**
 * Vehicle columns a search term matches against, mirroring starships.
 */
const VEHICLE_SEARCH_COLUMNS = [
  'vehicle.name',
  'vehicle.model',
  'vehicle.manufacturer',
  'vehicle.vehicle_class'
] as const;

/**
 * Statements reading the `film` table.
 */
export const FILM_STATEMENTS = {
  /**
   * Every film in saga order, optionally filtered.
   *
   * Matches `title` — a film's title is what it is known by — and also `director`, which is the one
   * other field someone plausibly searches a film catalogue by. `opening_crawl` is deliberately
   * excluded despite being text: matching it would make a search for `hope` return films whose
   * crawl merely mentions hope, which is not what the user asked and is impossible to explain from
   * a result list showing only titles.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery('film', FILM_COLUMNS, 'film.episode_id', FILM_SEARCH_COLUMNS, search),

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
   * Every character by name, optionally filtered.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery('person', PERSON_COLUMNS, 'person.name, person.id', PERSON_SEARCH_COLUMNS, search),

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
   * Every planet by name, optionally filtered.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery('planet', PLANET_COLUMNS, 'planet.name, planet.id', PLANET_SEARCH_COLUMNS, search),

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
   * Every species by name, optionally filtered.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery(
      'species',
      SPECIES_COLUMNS,
      'species.name, species.id',
      SPECIES_SEARCH_COLUMNS,
      search
    ),

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
   * Every starship by name, optionally filtered.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery(
      'starship',
      STARSHIP_COLUMNS,
      'starship.name, starship.id',
      STARSHIP_SEARCH_COLUMNS,
      search
    ),

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
   * Every vehicle by name, optionally filtered.
   *
   * @param search Validated search term, or `undefined` for the full collection.
   * @returns The statement and its bindings.
   */
  list: (search: string | undefined): BoundStatement =>
    listQuery(
      'vehicle',
      VEHICLE_COLUMNS,
      'vehicle.name, vehicle.id',
      VEHICLE_SEARCH_COLUMNS,
      search
    ),

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
