/**
 * @file Persistence ports for the Star Wars dataset, owned by the domain tier rather than by the
 *   GraphQL layer or by D1.
 *
 *   ## Why every relation method is batched
 *
 *   Each port exposes `findByIds` and `findBy<Parent>Ids` rather than `findById` and
 *   `findBy<Parent>Id`. That plural shape is the single most important design decision in this
 *   demo, and it is deliberately baked into the _interface_ rather than left to an implementation.
 *   A GraphQL query like `{ films { characters { homeworld { name } } } }` resolves three nested
 *   levels over many parents. With singular methods, the resolver for `characters` would run once
 *   per film and the resolver for `homeworld` once per character — the N+1 problem, and with D1
 *   every one of those is a separate round trip. Because these ports only accept _sets_ of
 *   identifiers, the application tier is structurally unable to make that mistake: it must collect
 *   the keys for a level and ask once. The DataLoader wiring in
 *   `src/worker/application/graphql/types/refs.ts` does the collecting; these signatures are what
 *   force it. The cost of a query therefore scales with the number of _relations selected_, not
 *   with the number of rows returned. `films { characters { homeworld { name } } }` is three
 *   statements whether it covers six films or six hundred.
 *
 *   ## Why `list` takes the search term
 *
 *   Each port's `list` accepts an optional, already-validated search term rather than returning
 *   everything for the caller to filter. That is the same discipline the batched methods enforce,
 *   applied to a different axis: the port's shape makes the efficient implementation the only one
 *   expressible. Filtering in a resolver would mean reading all 82 characters to display 3, which
 *   is affordable at this size and wrong at any other — and a demo that models it that way teaches
 *   the wrong reflex. Pushing the predicate into the port means it reaches SQL, where a `WHERE`
 *   clause belongs. The term arrives validated: bounding and trimming happen in `./search-term.ts`,
 *   above these ports, so no implementation has to re-check it and every transport enforces one
 *   rule.
 *
 *   ## Ordering and absent rows
 *
 *   Implementations return results in a defined order (documented per method) so that a given query
 *   produces a stable response across requests — important for a demo whose output is read aloud,
 *   and for caching. A requested identifier that does not exist is simply absent from the result
 *   array rather than raising: a null field is the correct GraphQL answer for a dangling reference,
 *   and one bad identifier in a batch must not fail the other entities sharing that statement.
 */

import type { Film, Person, Planet, Species, Starship, Vehicle } from './entities';
import type { Related } from './related';

/**
 * Reads of the `film` table.
 */
export interface FilmRepository {
  /**
   * List every film.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only films whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All films in saga order (by episode number). When a search term is given, the matching
   *   subset in the same order. An unmatched term yields an empty array rather than an error:
   *   finding nothing is a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Film[]>;

  /**
   * Load films by primary key.
   *
   * @param ids Film identifiers to load; may contain identifiers that do not exist.
   * @returns The films that exist, in unspecified order. Identifiers with no matching row are
   *   absent from the result rather than represented by a placeholder, so the caller decides
   *   whether a missing entity is a null field or an error.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Film[]>;

  /**
   * Load the films each of several characters appears in.
   *
   * @param personIds Character identifiers to load films for.
   * @param limit Optional maximum number of films per character, already validated by
   *   `validateRelationLimit` (see `./relation-limit.ts`). Applied per character, not across the
   *   whole result.
   * @returns Films tagged with the character they belong to, ordered by character and then by
   *   episode number.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByPersonIds(personIds: readonly string[], limit?: number): Promise<Related<Film>[]>;

  /**
   * Load the films each of several planets appears in.
   *
   * @param planetIds Planet identifiers to load films for.
   * @param limit Optional maximum number of films per planet.
   * @returns Films tagged with the planet they belong to, ordered by planet and then by episode
   *   number.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByPlanetIds(planetIds: readonly string[], limit?: number): Promise<Related<Film>[]>;

  /**
   * Load the films each of several species appears in.
   *
   * @param speciesIds Species identifiers to load films for.
   * @param limit Optional maximum number of films per species.
   * @returns Films tagged with the species they belong to, ordered by species and then by episode
   *   number.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findBySpeciesIds(speciesIds: readonly string[], limit?: number): Promise<Related<Film>[]>;

  /**
   * Load the films each of several starships appears in.
   *
   * @param starshipIds Starship identifiers to load films for.
   * @param limit Optional maximum number of films per starship.
   * @returns Films tagged with the starship they belong to, ordered by starship and then by episode
   *   number.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByStarshipIds(starshipIds: readonly string[], limit?: number): Promise<Related<Film>[]>;

  /**
   * Load the films each of several vehicles appears in.
   *
   * @param vehicleIds Vehicle identifiers to load films for.
   * @param limit Optional maximum number of films per vehicle.
   * @returns Films tagged with the vehicle they belong to, ordered by vehicle and then by episode
   *   number.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByVehicleIds(vehicleIds: readonly string[], limit?: number): Promise<Related<Film>[]>;
}

/**
 * Reads of the `person` table.
 */
export interface PersonRepository {
  /**
   * List every character.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only characters whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All characters ordered by name. When a search term is given, the matching subset in
   *   the same order. An unmatched term yields an empty array rather than an error: finding nothing
   *   is a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Person[]>;

  /**
   * Load characters by primary key.
   *
   * @param ids Character identifiers to load.
   * @returns The characters that exist, in unspecified order; missing identifiers are absent.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Person[]>;

  /**
   * Load the characters appearing in each of several films.
   *
   * @param filmIds Film identifiers to load characters for.
   * @param limit Optional maximum number of characters per film.
   * @returns Characters tagged with the film they belong to, ordered by film and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Person>[]>;

  /**
   * Load the residents of each of several planets.
   *
   * @param planetIds Planet identifiers to load residents for.
   * @param limit Optional maximum number of residents per planet.
   * @returns Characters tagged with the planet they call home, ordered by planet and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByPlanetIds(planetIds: readonly string[], limit?: number): Promise<Related<Person>[]>;

  /**
   * Load the members of each of several species.
   *
   * @param speciesIds Species identifiers to load members for.
   * @param limit Optional maximum number of members per species.
   * @returns Characters tagged with their species, ordered by species and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findBySpeciesIds(speciesIds: readonly string[], limit?: number): Promise<Related<Person>[]>;

  /**
   * Load the pilots of each of several starships.
   *
   * @param starshipIds Starship identifiers to load pilots for.
   * @param limit Optional maximum number of pilots per starship.
   * @returns Characters tagged with the starship they pilot, ordered by starship and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByStarshipIds(starshipIds: readonly string[], limit?: number): Promise<Related<Person>[]>;

  /**
   * Load the pilots of each of several vehicles.
   *
   * @param vehicleIds Vehicle identifiers to load pilots for.
   * @param limit Optional maximum number of pilots per vehicle.
   * @returns Characters tagged with the vehicle they pilot, ordered by vehicle and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByVehicleIds(vehicleIds: readonly string[], limit?: number): Promise<Related<Person>[]>;
}

/**
 * Reads of the `planet` table.
 */
export interface PlanetRepository {
  /**
   * List every planet.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only planets whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All planets ordered by name. When a search term is given, the matching subset in the
   *   same order. An unmatched term yields an empty array rather than an error: finding nothing is
   *   a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Planet[]>;

  /**
   * Load planets by primary key.
   *
   * Also serves the single-valued `homeworld` relation on both characters and species, which is
   * already a foreign key on the parent row and so needs only a keyed load.
   *
   * @param ids Planet identifiers to load.
   * @returns The planets that exist, in unspecified order; missing identifiers are absent.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Planet[]>;

  /**
   * Load the planets appearing in each of several films.
   *
   * @param filmIds Film identifiers to load planets for.
   * @param limit Optional maximum number of planets per film.
   * @returns Planets tagged with the film they belong to, ordered by film and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Planet>[]>;
}

/**
 * Reads of the `species` table.
 */
export interface SpeciesRepository {
  /**
   * List every species.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only species whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All species ordered by name. When a search term is given, the matching subset in the
   *   same order. An unmatched term yields an empty array rather than an error: finding nothing is
   *   a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Species[]>;

  /**
   * Load species by primary key.
   *
   * @param ids Species identifiers to load.
   * @returns The species that exist, in unspecified order; missing identifiers are absent.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Species[]>;

  /**
   * Load the species appearing in each of several films.
   *
   * @param filmIds Film identifiers to load species for.
   * @param limit Optional maximum number of species per film.
   * @returns Species tagged with the film they belong to, ordered by film and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Species>[]>;
}

/**
 * Reads of the `starship` table.
 */
export interface StarshipRepository {
  /**
   * List every starship.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only starships whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All starships ordered by name. When a search term is given, the matching subset in the
   *   same order. An unmatched term yields an empty array rather than an error: finding nothing is
   *   a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Starship[]>;

  /**
   * Load starships by primary key.
   *
   * @param ids Starship identifiers to load.
   * @returns The starships that exist, in unspecified order; missing identifiers are absent.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Starship[]>;

  /**
   * Load the starships appearing in each of several films.
   *
   * @param filmIds Film identifiers to load starships for.
   * @param limit Optional maximum number of starships per film.
   * @returns Starships tagged with the film they belong to, ordered by film and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Starship>[]>;

  /**
   * Load the starships piloted by each of several characters.
   *
   * @param personIds Character identifiers to load starships for.
   * @param limit Optional maximum number of starships per character.
   * @returns Starships tagged with the character who pilots them, ordered by character and then by
   *   name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByPersonIds(personIds: readonly string[], limit?: number): Promise<Related<Starship>[]>;
}

/**
 * Reads of the `vehicle` table.
 */
export interface VehicleRepository {
  /**
   * List every vehicle.
   *
   * @param search Optional search term, already validated and trimmed by `validateSearchTerm` (see
   *   `./search-term.ts`). When present, only vehicles whose searchable fields contain it as a
   *   case-insensitive substring are returned; when absent, the whole collection is.
   * @returns All vehicles ordered by name. When a search term is given, the matching subset in the
   *   same order. An unmatched term yields an empty array rather than an error: finding nothing is
   *   a valid answer to a search, not a failure.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(search?: string): Promise<Vehicle[]>;

  /**
   * Load vehicles by primary key.
   *
   * @param ids Vehicle identifiers to load.
   * @returns The vehicles that exist, in unspecified order; missing identifiers are absent.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByIds(ids: readonly string[]): Promise<Vehicle[]>;

  /**
   * Load the vehicles appearing in each of several films.
   *
   * @param filmIds Film identifiers to load vehicles for.
   * @param limit Optional maximum number of vehicles per film.
   * @returns Vehicles tagged with the film they belong to, ordered by film and then by name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Vehicle>[]>;

  /**
   * Load the vehicles piloted by each of several characters.
   *
   * @param personIds Character identifiers to load vehicles for.
   * @param limit Optional maximum number of vehicles per character.
   * @returns Vehicles tagged with the character who pilots them, ordered by character and then by
   *   name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByPersonIds(personIds: readonly string[], limit?: number): Promise<Related<Vehicle>[]>;
}

/**
 * The complete set of persistence ports the application tier depends on.
 *
 * Grouping them into one object keeps the composition root in `src/worker/index.ts` readable and
 * gives the GraphQL context a single, typed thing to carry, rather than six separately injected
 * repositories threaded through every resolver.
 */
export interface SwapiRepositories {
  /**
   * Film reads.
   */
  films: FilmRepository;
  /**
   * Character reads.
   */
  people: PersonRepository;
  /**
   * Planet reads.
   */
  planets: PlanetRepository;
  /**
   * Species reads.
   */
  species: SpeciesRepository;
  /**
   * Starship reads.
   */
  starships: StarshipRepository;
  /**
   * Vehicle reads.
   */
  vehicles: VehicleRepository;
}
