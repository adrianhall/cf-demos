/** Defines the Film GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findPeopleByFilmIds } from "../../data/repositories/person";
import { findPlanetsByFilmIds } from "../../data/repositories/planet";
import { findSpeciesByFilmIds } from "../../data/repositories/species";
import { findStarshipsByFilmIds } from "../../data/repositories/starship";
import { findVehiclesByFilmIds } from "../../data/repositories/vehicle";
import {
  filmType,
  personType,
  planetType,
  speciesType,
  starshipType,
  vehicleType,
} from "./refs";

filmType.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    episodeId: t.exposeString("episodeId"),
    title: t.exposeString("title"),
    openingCrawl: t.exposeString("openingCrawl"),
    director: t.exposeString("director"),
    producer: t.exposeString("producer"),
    releaseDate: t.exposeString("releaseDate"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    characters: t.loadableGroup({
      type: personType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPeopleByFilmIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (film) => film.id,
    }),
    planets: t.loadableGroup({
      type: planetType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPlanetsByFilmIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (film) => film.id,
    }),
    species: t.loadableGroup({
      type: speciesType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findSpeciesByFilmIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (film) => film.id,
    }),
    starships: t.loadableGroup({
      type: starshipType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findStarshipsByFilmIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (film) => film.id,
    }),
    vehicles: t.loadableGroup({
      type: vehicleType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findVehiclesByFilmIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (film) => film.id,
    }),
  }),
});
