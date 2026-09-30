/**
 * @file Row shapes, column projections, and row-to-entity mappers for each table. This is the
 *   boundary where the database's naming stops. Every column is snake_case in SQLite and camelCase
 *   in the domain entities, and the mappers below are the only place that translation happens —
 *   nothing above the infrastructure tier ever sees `opening_crawl` or `homeworld_id`. Each table's
 *   columns are declared once, as a constant, and the `*_COLUMNS` projection is derived from that
 *   list. That matters because the projection is interpolated into SQL while the `*Row` interface
 *   types the result: if the two disagreed, a query would silently return `undefined` for a field
 *   the type system insists is a `string`. Deriving the projection from the same list the interface
 *   mirrors keeps the two in step, and `tests/integration/schema.test.ts` asserts that these lists
 *   still match the real table definitions. Every projection is explicit rather than `SELECT *`. A
 *   star projection would bind the result shape to the physical column order of the migration, so
 *   adding a column later would change what every query returns.
 */

import type { Film, Person, Planet, Species, Starship, Vehicle } from '../../domain/entities';

/**
 * Build a qualified, comma-separated projection from a table's column list.
 *
 * Columns are qualified with the table name because relation queries join two tables, and both the
 * `film` and `person` tables have an `id`, a `created`, and an `edited` column. An unqualified
 * projection would be ambiguous in exactly the queries that matter most here.
 *
 * @param table Table name to qualify each column with.
 * @param columns Column names, in the order the matching row interface declares them.
 * @returns A projection such as `film.id, film.title`.
 */
function project(table: string, columns: readonly string[]): string {
  return columns.map((column) => `${table}.${column}`).join(', ');
}

/**
 * Columns of the `film` table, in migration order.
 */
export const FILM_COLUMN_NAMES = [
  'id',
  'episode_id',
  'title',
  'opening_crawl',
  'director',
  'producer',
  'release_date',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `film` projection.
 */
export const FILM_COLUMNS = project('film', FILM_COLUMN_NAMES);

/**
 * A `film` row exactly as D1 returns it.
 */
export interface FilmRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Episode number.
   */
  episode_id: string;
  /**
   * Film title.
   */
  title: string;
  /**
   * Opening crawl text.
   */
  opening_crawl: string;
  /**
   * Director's name.
   */
  director: string;
  /**
   * Producers.
   */
  producer: string;
  /**
   * Release date.
   */
  release_date: string;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `film` row to its domain entity.
 *
 * @param row Row selected using {@link FILM_COLUMNS}.
 * @returns The equivalent {@link Film}.
 */
export function toFilm(row: FilmRow): Film {
  return {
    id: row.id,
    episodeId: row.episode_id,
    title: row.title,
    openingCrawl: row.opening_crawl,
    director: row.director,
    producer: row.producer,
    releaseDate: row.release_date,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}

/**
 * Columns of the `person` table, in migration order.
 */
export const PERSON_COLUMN_NAMES = [
  'id',
  'name',
  'height',
  'mass',
  'hair_color',
  'skin_color',
  'eye_color',
  'birth_year',
  'gender',
  'homeworld_id',
  'species_id',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `person` projection.
 */
export const PERSON_COLUMNS = project('person', PERSON_COLUMN_NAMES);

/**
 * A `person` row exactly as D1 returns it.
 */
export interface PersonRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Character name.
   */
  name: string;
  /**
   * Height in centimetres, as text.
   */
  height: string;
  /**
   * Mass in kilograms, as text.
   */
  mass: string;
  /**
   * Hair colour.
   */
  hair_color: string;
  /**
   * Skin colour.
   */
  skin_color: string;
  /**
   * Eye colour.
   */
  eye_color: string;
  /**
   * Birth year in in-universe notation.
   */
  birth_year: string;
  /**
   * Gender.
   */
  gender: string;
  /**
   * Home planet foreign key; nullable in the schema.
   */
  homeworld_id: string | null;
  /**
   * Species foreign key; nullable in the schema.
   */
  species_id: string | null;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `person` row to its domain entity.
 *
 * @param row Row selected using {@link PERSON_COLUMNS}.
 * @returns The equivalent {@link Person}.
 */
export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    height: row.height,
    mass: row.mass,
    hairColor: row.hair_color,
    skinColor: row.skin_color,
    eyeColor: row.eye_color,
    birthYear: row.birth_year,
    gender: row.gender,
    homeworldId: row.homeworld_id,
    speciesId: row.species_id,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}

/**
 * Columns of the `planet` table, in migration order.
 */
export const PLANET_COLUMN_NAMES = [
  'id',
  'name',
  'rotation_period',
  'orbital_period',
  'diameter',
  'climate',
  'gravity',
  'terrain',
  'surface_water',
  'population',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `planet` projection.
 */
export const PLANET_COLUMNS = project('planet', PLANET_COLUMN_NAMES);

/**
 * A `planet` row exactly as D1 returns it.
 */
export interface PlanetRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Planet name.
   */
  name: string;
  /**
   * Rotation period in standard hours, as text.
   */
  rotation_period: string;
  /**
   * Orbital period in standard days, as text.
   */
  orbital_period: string;
  /**
   * Diameter in kilometres, as text.
   */
  diameter: string;
  /**
   * Climate descriptions.
   */
  climate: string;
  /**
   * Gravity relative to standard.
   */
  gravity: string;
  /**
   * Terrain descriptions.
   */
  terrain: string;
  /**
   * Percentage of surface water, as text.
   */
  surface_water: string;
  /**
   * Population, as text.
   */
  population: string;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `planet` row to its domain entity.
 *
 * @param row Row selected using {@link PLANET_COLUMNS}.
 * @returns The equivalent {@link Planet}.
 */
export function toPlanet(row: PlanetRow): Planet {
  return {
    id: row.id,
    name: row.name,
    rotationPeriod: row.rotation_period,
    orbitalPeriod: row.orbital_period,
    diameter: row.diameter,
    climate: row.climate,
    gravity: row.gravity,
    terrain: row.terrain,
    surfaceWater: row.surface_water,
    population: row.population,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}

/**
 * Columns of the `species` table, in migration order.
 */
export const SPECIES_COLUMN_NAMES = [
  'id',
  'name',
  'classification',
  'designation',
  'average_height',
  'skin_colors',
  'hair_colors',
  'eye_colors',
  'average_lifespan',
  'homeworld_id',
  'language',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `species` projection.
 */
export const SPECIES_COLUMNS = project('species', SPECIES_COLUMN_NAMES);

/**
 * A `species` row exactly as D1 returns it.
 */
export interface SpeciesRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Species name.
   */
  name: string;
  /**
   * Biological classification.
   */
  classification: string;
  /**
   * Designation, such as `sentient`.
   */
  designation: string;
  /**
   * Average height in centimetres, as text.
   */
  average_height: string;
  /**
   * Skin colours.
   */
  skin_colors: string;
  /**
   * Hair colours.
   */
  hair_colors: string;
  /**
   * Eye colours.
   */
  eye_colors: string;
  /**
   * Average lifespan in standard years, as text.
   */
  average_lifespan: string;
  /**
   * Home planet foreign key; nullable in the schema.
   */
  homeworld_id: string | null;
  /**
   * Primary language.
   */
  language: string;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `species` row to its domain entity.
 *
 * @param row Row selected using {@link SPECIES_COLUMNS}.
 * @returns The equivalent {@link Species}.
 */
export function toSpecies(row: SpeciesRow): Species {
  return {
    id: row.id,
    name: row.name,
    classification: row.classification,
    designation: row.designation,
    averageHeight: row.average_height,
    skinColors: row.skin_colors,
    hairColors: row.hair_colors,
    eyeColors: row.eye_colors,
    averageLifespan: row.average_lifespan,
    homeworldId: row.homeworld_id,
    language: row.language,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}

/**
 * Columns of the `starship` table, in migration order.
 */
export const STARSHIP_COLUMN_NAMES = [
  'id',
  'name',
  'model',
  'manufacturer',
  'cost_in_credits',
  'length',
  'max_atmosphering_speed',
  'crew',
  'passengers',
  'cargo_capacity',
  'consumables',
  'hyperdrive_rating',
  'mglt',
  'starship_class',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `starship` projection.
 */
export const STARSHIP_COLUMNS = project('starship', STARSHIP_COLUMN_NAMES);

/**
 * A `starship` row exactly as D1 returns it.
 */
export interface StarshipRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Common name.
   */
  name: string;
  /**
   * Model designation.
   */
  model: string;
  /**
   * Manufacturers.
   */
  manufacturer: string;
  /**
   * Cost in credits, as text.
   */
  cost_in_credits: string;
  /**
   * Length in metres, as text.
   */
  length: string;
  /**
   * Maximum atmospheric speed, as text.
   */
  max_atmosphering_speed: string;
  /**
   * Crew complement, as text.
   */
  crew: string;
  /**
   * Passenger capacity, as text.
   */
  passengers: string;
  /**
   * Cargo capacity in kilograms, as text.
   */
  cargo_capacity: string;
  /**
   * Consumables duration.
   */
  consumables: string;
  /**
   * Hyperdrive class rating, as text.
   */
  hyperdrive_rating: string;
  /**
   * Speed in MGLT, as text.
   */
  mglt: string;
  /**
   * Starship class.
   */
  starship_class: string;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `starship` row to its domain entity.
 *
 * @param row Row selected using {@link STARSHIP_COLUMNS}.
 * @returns The equivalent {@link Starship}.
 */
export function toStarship(row: StarshipRow): Starship {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    manufacturer: row.manufacturer,
    costInCredits: row.cost_in_credits,
    length: row.length,
    maxAtmospheringSpeed: row.max_atmosphering_speed,
    crew: row.crew,
    passengers: row.passengers,
    cargoCapacity: row.cargo_capacity,
    consumables: row.consumables,
    hyperdriveRating: row.hyperdrive_rating,
    mglt: row.mglt,
    starshipClass: row.starship_class,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}

/**
 * Columns of the `vehicle` table, in migration order.
 */
export const VEHICLE_COLUMN_NAMES = [
  'id',
  'name',
  'model',
  'manufacturer',
  'cost_in_credits',
  'length',
  'max_atmosphering_speed',
  'crew',
  'passengers',
  'cargo_capacity',
  'consumables',
  'vehicle_class',
  'created',
  'edited',
  'url'
] as const;

/**
 * Qualified `vehicle` projection.
 */
export const VEHICLE_COLUMNS = project('vehicle', VEHICLE_COLUMN_NAMES);

/**
 * A `vehicle` row exactly as D1 returns it.
 */
export interface VehicleRow {
  /**
   * Primary key.
   */
  id: string;
  /**
   * Common name.
   */
  name: string;
  /**
   * Model designation.
   */
  model: string;
  /**
   * Manufacturers.
   */
  manufacturer: string;
  /**
   * Cost in credits, as text.
   */
  cost_in_credits: string;
  /**
   * Length in metres, as text.
   */
  length: string;
  /**
   * Maximum atmospheric speed, as text.
   */
  max_atmosphering_speed: string;
  /**
   * Crew complement, as text.
   */
  crew: string;
  /**
   * Passenger capacity, as text.
   */
  passengers: string;
  /**
   * Cargo capacity in kilograms, as text.
   */
  cargo_capacity: string;
  /**
   * Consumables duration.
   */
  consumables: string;
  /**
   * Vehicle class.
   */
  vehicle_class: string;
  /**
   * Upstream creation timestamp.
   */
  created: string;
  /**
   * Upstream edit timestamp.
   */
  edited: string;
  /**
   * Canonical upstream URL.
   */
  url: string;
}

/**
 * Map a `vehicle` row to its domain entity.
 *
 * @param row Row selected using {@link VEHICLE_COLUMNS}.
 * @returns The equivalent {@link Vehicle}.
 */
export function toVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    manufacturer: row.manufacturer,
    costInCredits: row.cost_in_credits,
    length: row.length,
    maxAtmospheringSpeed: row.max_atmosphering_speed,
    crew: row.crew,
    passengers: row.passengers,
    cargoCapacity: row.cargo_capacity,
    consumables: row.consumables,
    vehicleClass: row.vehicle_class,
    created: row.created,
    edited: row.edited,
    url: row.url
  };
}
