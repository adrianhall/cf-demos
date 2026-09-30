/**
 * @file The six Star Wars entities this API exposes, in the camelCased shape the rest of the
 *   application uses. Every scalar is a `string`, including fields that look numeric such as
 *   `episodeId`, `mass`, and `diameter`. That mirrors the source dataset, which uses sentinel text
 *   like `"unknown"` and `"n/a"` in those positions (see
 *   `migrations/0001_create_swapi_schema.sql`). Parsing them into numbers would mean either
 *   inventing a value or dropping the field, so the API reports what the dataset actually says and
 *   leaves interpretation to the caller. Relations are represented two different ways, and the
 *   difference is meaningful:
 *
 *   - A **single-valued** relation is a nullable foreign-key field on the entity itself, such as
 *     {@link Person.homeworldId}. It is already present on the row, so resolving it needs no
 *     further query beyond loading the referenced entity by ID.
 *   - A **multi-valued** relation is absent from these types entirely. `Film` has no `characterIds`
 *     array, because storing one would mean either loading every relation for every entity read or
 *     letting the field lie about what was fetched. Multi-valued relations are resolved on demand
 *     by the batched loaders in `src/worker/infrastructure/`, which is what keeps a query's cost
 *     proportional to what it actually selected.
 */

/**
 * A Star Wars film.
 */
export interface Film {
  /**
   * Stable UUID primary key, derived from the source resource URL.
   */
  id: string;
  /**
   * Episode number within the saga, as text.
   */
  episodeId: string;
  /**
   * Film title.
   */
  title: string;
  /**
   * Full text of the film's opening crawl, including its line breaks.
   */
  openingCrawl: string;
  /**
   * Director's name.
   */
  director: string;
  /**
   * Comma-separated list of producers.
   */
  producer: string;
  /**
   * Original release date in `YYYY-MM-DD` form.
   */
  releaseDate: string;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}

/**
 * A character appearing in the saga.
 */
export interface Person {
  /**
   * Stable UUID primary key, derived from the source resource URL.
   */
  id: string;
  /**
   * Character name.
   */
  name: string;
  /**
   * Height in centimetres, as text; may be `"unknown"`.
   */
  height: string;
  /**
   * Mass in kilograms, as text; may be `"unknown"`.
   */
  mass: string;
  /**
   * Hair colour, or a sentinel such as `"n/a"`.
   */
  hairColor: string;
  /**
   * Skin colour.
   */
  skinColor: string;
  /**
   * Eye colour.
   */
  eyeColor: string;
  /**
   * Birth year in in-universe notation (for example `"19BBY"`), or `"unknown"`.
   */
  birthYear: string;
  /**
   * Gender, or a sentinel such as `"n/a"` for droids.
   */
  gender: string;
  /**
   * Home planet's identifier, or `null` when the dataset records none.
   */
  homeworldId: string | null;
  /**
   * Species identifier, or `null`. Upstream models this as a zero-or-one list; the seed rejects any
   * character with more than one species rather than silently discarding data.
   */
  speciesId: string | null;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}

/**
 * A planet.
 */
export interface Planet {
  /**
   * Stable UUID primary key, derived from the source resource URL.
   */
  id: string;
  /**
   * Planet name.
   */
  name: string;
  /**
   * Rotation period in standard hours, as text.
   */
  rotationPeriod: string;
  /**
   * Orbital period in standard days, as text.
   */
  orbitalPeriod: string;
  /**
   * Diameter in kilometres, as text.
   */
  diameter: string;
  /**
   * Comma-separated climate descriptions.
   */
  climate: string;
  /**
   * Gravity relative to standard, as text.
   */
  gravity: string;
  /**
   * Comma-separated terrain descriptions.
   */
  terrain: string;
  /**
   * Percentage of the surface covered by water, as text.
   */
  surfaceWater: string;
  /**
   * Population, as text; may be `"unknown"`.
   */
  population: string;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}

/**
 * A species.
 */
export interface Species {
  /**
   * Stable UUID primary key, derived from the source resource URL.
   */
  id: string;
  /**
   * Species name.
   */
  name: string;
  /**
   * Biological classification, such as `"mammal"`.
   */
  classification: string;
  /**
   * Designation, such as `"sentient"`.
   */
  designation: string;
  /**
   * Average height in centimetres, as text.
   */
  averageHeight: string;
  /**
   * Comma-separated skin colours.
   */
  skinColors: string;
  /**
   * Comma-separated hair colours.
   */
  hairColors: string;
  /**
   * Comma-separated eye colours.
   */
  eyeColors: string;
  /**
   * Average lifespan in standard years, as text; may be `"indefinite"`.
   */
  averageLifespan: string;
  /**
   * Home planet's identifier, or `null` when the dataset records none.
   */
  homeworldId: string | null;
  /**
   * Primary language.
   */
  language: string;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}

/**
 * A starship: a vessel with hyperdrive capability.
 */
export interface Starship {
  /**
   * Stable UUID primary key, derived from the source resource URL.
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
   * Comma-separated manufacturers.
   */
  manufacturer: string;
  /**
   * Cost in galactic credits, as text; may be `"unknown"`.
   */
  costInCredits: string;
  /**
   * Length in metres, as text.
   */
  length: string;
  /**
   * Maximum atmospheric speed, as text.
   */
  maxAtmospheringSpeed: string;
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
  cargoCapacity: string;
  /**
   * Length of time the ship can provide consumables for its crew.
   */
  consumables: string;
  /**
   * Hyperdrive class rating, as text.
   */
  hyperdriveRating: string;
  /**
   * Maximum speed in Modern Galactic Light Time units, as text.
   */
  mglt: string;
  /**
   * Class of starship, such as `"Star Destroyer"`.
   */
  starshipClass: string;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}

/**
 * A vehicle: craft without hyperdrive capability.
 */
export interface Vehicle {
  /**
   * Stable UUID primary key, derived from the source resource URL.
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
   * Comma-separated manufacturers.
   */
  manufacturer: string;
  /**
   * Cost in galactic credits, as text; may be `"unknown"`.
   */
  costInCredits: string;
  /**
   * Length in metres, as text.
   */
  length: string;
  /**
   * Maximum atmospheric speed, as text.
   */
  maxAtmospheringSpeed: string;
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
  cargoCapacity: string;
  /**
   * Length of time the vehicle can provide consumables for its crew.
   */
  consumables: string;
  /**
   * Class of vehicle, such as `"wheeled walker"`.
   */
  vehicleClass: string;
  /**
   * ISO-8601 timestamp when the upstream record was created.
   */
  created: string;
  /**
   * ISO-8601 timestamp when the upstream record was last edited.
   */
  edited: string;
  /**
   * Canonical upstream resource URL this record was seeded from.
   */
  url: string;
}
