/** Creates concrete Pothos references so cyclic SWAPI relations remain type-safe. */
import type { Film } from "../../data/tables/film";
import type { Person } from "../../data/tables/person";
import type { Planet } from "../../data/tables/planet";
import type { Species } from "../../data/tables/species";
import type { Starship } from "../../data/tables/starship";
import type { Vehicle } from "../../data/tables/vehicle";
import { builder } from "../builder";
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { findFilmsByIds } from "../../data/repositories/film";
import { findPeopleByIds } from "../../data/repositories/person";
import { findPlanetsByIds } from "../../data/repositories/planet";
import { findSpeciesByIds } from "../../data/repositories/species";
import { findStarshipsByIds } from "../../data/repositories/starship";
import { findVehiclesByIds } from "../../data/repositories/vehicle";

/** Pothos reference for a Film object. */
export const filmType = builder.loadableObjectRef<Film, string>("Film", {
  load: (ids, env) => findFilmsByIds(env, ids),
  toKey: (film) => film.id,
  sort: true,
  cacheResolved: true,
  loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
});

/** Pothos reference for a Person object. */
export const personType = builder.loadableObjectRef<Person, string>("Person", {
  load: (ids, env) => findPeopleByIds(env, ids),
  toKey: (person) => person.id,
  sort: true,
  cacheResolved: true,
  loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
});

/** Pothos reference for a Planet object. */
export const planetType = builder.loadableObjectRef<Planet, string>("Planet", {
  load: (ids, env) => findPlanetsByIds(env, ids),
  toKey: (planet) => planet.id,
  sort: true,
  cacheResolved: true,
  loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
});

/** Pothos reference for a Species object. */
export const speciesType = builder.loadableObjectRef<Species, string>(
  "Species",
  {
    load: (ids, env) => findSpeciesByIds(env, ids),
    toKey: (species) => species.id,
    sort: true,
    cacheResolved: true,
    loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
  },
);

/** Pothos reference for a Starship object. */
export const starshipType = builder.loadableObjectRef<Starship, string>(
  "Starship",
  {
    load: (ids, env) => findStarshipsByIds(env, ids),
    toKey: (starship) => starship.id,
    sort: true,
    cacheResolved: true,
    loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
  },
);

/** Pothos reference for a Vehicle object. */
export const vehicleType = builder.loadableObjectRef<Vehicle, string>(
  "Vehicle",
  {
    load: (ids, env) => findVehiclesByIds(env, ids),
    toKey: (vehicle) => vehicle.id,
    sort: true,
    cacheResolved: true,
    loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
  },
);
