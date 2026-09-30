/**
 * @file D1 implementations of the six persistence ports declared in `../domain/repositories.ts`.
 *   Each class is a thin adapter: pick the right statement, bind the identifiers, map the rows. All
 *   the reusable mechanics live in `./d1-reader.ts` and `./queries/`, which is what keeps these
 *   classes readable as a straight mapping from port method to SQL statement. D1 is the right
 *   storage for this dataset — rather than the Workers KV used by the sibling `link` demo — because
 *   the whole point of the API is relational traversal. A GraphQL caller composes the query shape
 *   at request time, so the joins cannot be precomputed; only a real query engine can answer `films
 *   { characters { homeworld { residents { name } } } }`. KV can be read by key or key prefix and
 *   nothing else, so serving this data from KV would mean storing pre-joined blobs for every
 *   traversal anyone might ask for. Every repository takes a {@link D1Reader} rather than a
 *   `D1Database`. Because that type exposes only `prepare`, these adapters are provably read-only.
 *   Every batched method is `async` even where it only forwards a promise. That is deliberate: the
 *   statement builders validate the batch size and throw a `RangeError` synchronously, so a
 *   non-`async` method would throw _before_ returning its promise. A caller who wrote
 *   `repository.findByIds([]).catch(handle)` would then not catch it — the exception would escape
 *   past the `.catch`, and inside a DataLoader it would surface as an unhandled rejection rather
 *   than a rejected load. Marking the methods `async` converts those synchronous throws into
 *   rejected promises, which is what the `Promise`-returning signature already promises.
 */

import type { Film, Person, Planet, Species, Starship, Vehicle } from '../domain/entities';
import type { Related } from '../domain/related';
import type {
  FilmRepository,
  PersonRepository,
  PlanetRepository,
  SpeciesRepository,
  StarshipRepository,
  SwapiRepositories,
  VehicleRepository
} from '../domain/repositories';
import { queryEntities, queryRelated, type D1Reader } from './d1-reader';
import {
  FILM_STATEMENTS,
  PERSON_STATEMENTS,
  PLANET_STATEMENTS,
  SPECIES_STATEMENTS,
  STARSHIP_STATEMENTS,
  VEHICLE_STATEMENTS
} from './queries/statements';
import {
  toFilm,
  toPerson,
  toPlanet,
  toSpecies,
  toStarship,
  toVehicle,
  type FilmRow,
  type PersonRow,
  type PlanetRow,
  type SpeciesRow,
  type StarshipRow,
  type VehicleRow
} from './queries/tables';

/**
 * D1-backed {@link FilmRepository}.
 */
export class D1FilmRepository implements FilmRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every film in saga order.
   *
   * @returns All films ordered by episode number.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Film[]> {
    const result = await this.database.prepare(FILM_STATEMENTS.list).all<FilmRow>();
    return result.results.map(toFilm);
  }

  /**
   * Load films by primary key.
   *
   * @param ids Film identifiers.
   * @returns The films that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Film[]> {
    return await queryEntities(this.database, FILM_STATEMENTS.byIds(ids.length), ids, toFilm);
  }

  /**
   * Load the films each character appears in.
   *
   * @param personIds Character identifiers.
   * @param limit Optional per-character film limit.
   * @returns Films tagged with their character, ordered by character then episode number.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByPersonIds(personIds: readonly string[], limit?: number): Promise<Related<Film>[]> {
    return await queryRelated(
      this.database,
      FILM_STATEMENTS.byPersonIds(personIds.length, limit),
      personIds,
      limit,
      toFilm
    );
  }

  /**
   * Load the films each planet appears in.
   *
   * @param planetIds Planet identifiers.
   * @param limit Optional per-planet film limit.
   * @returns Films tagged with their planet.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByPlanetIds(planetIds: readonly string[], limit?: number): Promise<Related<Film>[]> {
    return await queryRelated(
      this.database,
      FILM_STATEMENTS.byPlanetIds(planetIds.length, limit),
      planetIds,
      limit,
      toFilm
    );
  }

  /**
   * Load the films each species appears in.
   *
   * @param speciesIds Species identifiers.
   * @param limit Optional per-species film limit.
   * @returns Films tagged with their species.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findBySpeciesIds(speciesIds: readonly string[], limit?: number): Promise<Related<Film>[]> {
    return await queryRelated(
      this.database,
      FILM_STATEMENTS.bySpeciesIds(speciesIds.length, limit),
      speciesIds,
      limit,
      toFilm
    );
  }

  /**
   * Load the films each starship appears in.
   *
   * @param starshipIds Starship identifiers.
   * @param limit Optional per-starship film limit.
   * @returns Films tagged with their starship.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByStarshipIds(
    starshipIds: readonly string[],
    limit?: number
  ): Promise<Related<Film>[]> {
    return await queryRelated(
      this.database,
      FILM_STATEMENTS.byStarshipIds(starshipIds.length, limit),
      starshipIds,
      limit,
      toFilm
    );
  }

  /**
   * Load the films each vehicle appears in.
   *
   * @param vehicleIds Vehicle identifiers.
   * @param limit Optional per-vehicle film limit.
   * @returns Films tagged with their vehicle.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByVehicleIds(vehicleIds: readonly string[], limit?: number): Promise<Related<Film>[]> {
    return await queryRelated(
      this.database,
      FILM_STATEMENTS.byVehicleIds(vehicleIds.length, limit),
      vehicleIds,
      limit,
      toFilm
    );
  }
}

/**
 * D1-backed {@link PersonRepository}.
 */
export class D1PersonRepository implements PersonRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every character by name.
   *
   * @returns All characters ordered by name.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Person[]> {
    const result = await this.database.prepare(PERSON_STATEMENTS.list).all<PersonRow>();
    return result.results.map(toPerson);
  }

  /**
   * Load characters by primary key.
   *
   * @param ids Character identifiers.
   * @returns The characters that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Person[]> {
    return await queryEntities(this.database, PERSON_STATEMENTS.byIds(ids.length), ids, toPerson);
  }

  /**
   * Load the characters appearing in each film.
   *
   * @param filmIds Film identifiers.
   * @param limit Optional per-film character limit.
   * @returns Characters tagged with their film, ordered by film then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Person>[]> {
    return await queryRelated(
      this.database,
      PERSON_STATEMENTS.byFilmIds(filmIds.length, limit),
      filmIds,
      limit,
      toPerson
    );
  }

  /**
   * Load the residents of each planet.
   *
   * @param planetIds Planet identifiers.
   * @param limit Optional per-planet resident limit.
   * @returns Characters tagged with their homeworld.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByPlanetIds(planetIds: readonly string[], limit?: number): Promise<Related<Person>[]> {
    return await queryRelated(
      this.database,
      PERSON_STATEMENTS.byPlanetIds(planetIds.length, limit),
      planetIds,
      limit,
      toPerson
    );
  }

  /**
   * Load the members of each species.
   *
   * @param speciesIds Species identifiers.
   * @param limit Optional per-species member limit.
   * @returns Characters tagged with their species.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findBySpeciesIds(
    speciesIds: readonly string[],
    limit?: number
  ): Promise<Related<Person>[]> {
    return await queryRelated(
      this.database,
      PERSON_STATEMENTS.bySpeciesIds(speciesIds.length, limit),
      speciesIds,
      limit,
      toPerson
    );
  }

  /**
   * Load the pilots of each starship.
   *
   * @param starshipIds Starship identifiers.
   * @param limit Optional per-starship pilot limit.
   * @returns Characters tagged with the starship they pilot.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByStarshipIds(
    starshipIds: readonly string[],
    limit?: number
  ): Promise<Related<Person>[]> {
    return await queryRelated(
      this.database,
      PERSON_STATEMENTS.byStarshipIds(starshipIds.length, limit),
      starshipIds,
      limit,
      toPerson
    );
  }

  /**
   * Load the pilots of each vehicle.
   *
   * @param vehicleIds Vehicle identifiers.
   * @param limit Optional per-vehicle pilot limit.
   * @returns Characters tagged with the vehicle they pilot.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByVehicleIds(
    vehicleIds: readonly string[],
    limit?: number
  ): Promise<Related<Person>[]> {
    return await queryRelated(
      this.database,
      PERSON_STATEMENTS.byVehicleIds(vehicleIds.length, limit),
      vehicleIds,
      limit,
      toPerson
    );
  }
}

/**
 * D1-backed {@link PlanetRepository}.
 */
export class D1PlanetRepository implements PlanetRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every planet by name.
   *
   * @returns All planets ordered by name.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Planet[]> {
    const result = await this.database.prepare(PLANET_STATEMENTS.list).all<PlanetRow>();
    return result.results.map(toPlanet);
  }

  /**
   * Load planets by primary key, also serving the `homeworld` field on characters and species.
   *
   * @param ids Planet identifiers.
   * @returns The planets that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Planet[]> {
    return await queryEntities(this.database, PLANET_STATEMENTS.byIds(ids.length), ids, toPlanet);
  }

  /**
   * Load the planets appearing in each film.
   *
   * @param filmIds Film identifiers.
   * @param limit Optional per-film planet limit.
   * @returns Planets tagged with their film, ordered by film then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Planet>[]> {
    return await queryRelated(
      this.database,
      PLANET_STATEMENTS.byFilmIds(filmIds.length, limit),
      filmIds,
      limit,
      toPlanet
    );
  }
}

/**
 * D1-backed {@link SpeciesRepository}.
 */
export class D1SpeciesRepository implements SpeciesRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every species by name.
   *
   * @returns All species ordered by name.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Species[]> {
    const result = await this.database.prepare(SPECIES_STATEMENTS.list).all<SpeciesRow>();
    return result.results.map(toSpecies);
  }

  /**
   * Load species by primary key, also serving the `species` field on a character.
   *
   * @param ids Species identifiers.
   * @returns The species that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Species[]> {
    return await queryEntities(this.database, SPECIES_STATEMENTS.byIds(ids.length), ids, toSpecies);
  }

  /**
   * Load the species appearing in each film.
   *
   * @param filmIds Film identifiers.
   * @param limit Optional per-film species limit.
   * @returns Species tagged with their film, ordered by film then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Species>[]> {
    return await queryRelated(
      this.database,
      SPECIES_STATEMENTS.byFilmIds(filmIds.length, limit),
      filmIds,
      limit,
      toSpecies
    );
  }
}

/**
 * D1-backed {@link StarshipRepository}.
 */
export class D1StarshipRepository implements StarshipRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every starship by name.
   *
   * @returns All starships ordered by name.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Starship[]> {
    const result = await this.database.prepare(STARSHIP_STATEMENTS.list).all<StarshipRow>();
    return result.results.map(toStarship);
  }

  /**
   * Load starships by primary key.
   *
   * @param ids Starship identifiers.
   * @returns The starships that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Starship[]> {
    return await queryEntities(
      this.database,
      STARSHIP_STATEMENTS.byIds(ids.length),
      ids,
      toStarship
    );
  }

  /**
   * Load the starships appearing in each film.
   *
   * @param filmIds Film identifiers.
   * @param limit Optional per-film starship limit.
   * @returns Starships tagged with their film, ordered by film then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Starship>[]> {
    return await queryRelated(
      this.database,
      STARSHIP_STATEMENTS.byFilmIds(filmIds.length, limit),
      filmIds,
      limit,
      toStarship
    );
  }

  /**
   * Load the starships each character pilots.
   *
   * @param personIds Character identifiers.
   * @param limit Optional per-character starship limit.
   * @returns Starships tagged with their pilot, ordered by pilot then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByPersonIds(
    personIds: readonly string[],
    limit?: number
  ): Promise<Related<Starship>[]> {
    return await queryRelated(
      this.database,
      STARSHIP_STATEMENTS.byPersonIds(personIds.length, limit),
      personIds,
      limit,
      toStarship
    );
  }
}

/**
 * D1-backed {@link VehicleRepository}.
 */
export class D1VehicleRepository implements VehicleRepository {
  /**
   * @param database Read-only handle on the bound D1 database.
   */
  constructor(private readonly database: D1Reader) {}

  /**
   * List every vehicle by name.
   *
   * @returns All vehicles ordered by name.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Vehicle[]> {
    const result = await this.database.prepare(VEHICLE_STATEMENTS.list).all<VehicleRow>();
    return result.results.map(toVehicle);
  }

  /**
   * Load vehicles by primary key.
   *
   * @param ids Vehicle identifiers.
   * @returns The vehicles that exist; missing identifiers are absent.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByIds(ids: readonly string[]): Promise<Vehicle[]> {
    return await queryEntities(this.database, VEHICLE_STATEMENTS.byIds(ids.length), ids, toVehicle);
  }

  /**
   * Load the vehicles appearing in each film.
   *
   * @param filmIds Film identifiers.
   * @param limit Optional per-film vehicle limit.
   * @returns Vehicles tagged with their film, ordered by film then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByFilmIds(filmIds: readonly string[], limit?: number): Promise<Related<Vehicle>[]> {
    return await queryRelated(
      this.database,
      VEHICLE_STATEMENTS.byFilmIds(filmIds.length, limit),
      filmIds,
      limit,
      toVehicle
    );
  }

  /**
   * Load the vehicles each character pilots.
   *
   * @param personIds Character identifiers.
   * @param limit Optional per-character vehicle limit.
   * @returns Vehicles tagged with their pilot, ordered by pilot then name.
   * @throws {Error} When D1 rejects the query.
   * @throws {RangeError} When the batch is empty or larger than D1 can bind.
   */
  async findByPersonIds(personIds: readonly string[], limit?: number): Promise<Related<Vehicle>[]> {
    return await queryRelated(
      this.database,
      VEHICLE_STATEMENTS.byPersonIds(personIds.length, limit),
      personIds,
      limit,
      toVehicle
    );
  }
}

/**
 * Build the complete set of D1-backed repositories for one database.
 *
 * Called once per request by the composition root in `src/worker/index.ts`. Constructing six small
 * adapters is free — they hold nothing but the database handle — and doing it per request keeps the
 * DataLoader caches inside the application tier request-scoped, which is what prevents one caller's
 * results from being served to another.
 *
 * @param database Read-only handle on the bound D1 database.
 * @returns Every port the application tier needs, implemented against D1.
 */
export function createD1Repositories(database: D1Reader): SwapiRepositories {
  return {
    films: new D1FilmRepository(database),
    people: new D1PersonRepository(database),
    planets: new D1PlanetRepository(database),
    species: new D1SpeciesRepository(database),
    starships: new D1StarshipRepository(database),
    vehicles: new D1VehicleRepository(database)
  };
}
