/** Defines the Person GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findFilmsByPersonIds } from "../../data/repositories/film";
import { findStarshipsByPersonIds } from "../../data/repositories/starship";
import { findVehiclesByPersonIds } from "../../data/repositories/vehicle";
import {
  filmType,
  personType,
  planetType,
  speciesType,
  starshipType,
  vehicleType,
} from "./refs";

personType.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    height: t.exposeString("height"),
    mass: t.exposeString("mass"),
    hairColor: t.exposeString("hairColor"),
    skinColor: t.exposeString("skinColor"),
    eyeColor: t.exposeString("eyeColor"),
    birthYear: t.exposeString("birthYear"),
    gender: t.exposeString("gender"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    homeworld: t.field({
      type: planetType,
      nullable: true,
      resolve: (person) => person.homeworldId,
    }),
    species: t.field({
      type: speciesType,
      nullable: true,
      resolve: (person) => person.speciesId,
    }),
    films: t.loadableGroup({
      type: filmType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findFilmsByPersonIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (person) => person.id,
    }),
    starships: t.loadableGroup({
      type: starshipType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findStarshipsByPersonIds(
          env,
          ids.map(String),
          relationFirst(args.first),
        ),
      group: relatedParentId,
      resolve: (person) => person.id,
    }),
    vehicles: t.loadableGroup({
      type: vehicleType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findVehiclesByPersonIds(
          env,
          ids.map(String),
          relationFirst(args.first),
        ),
      group: relatedParentId,
      resolve: (person) => person.id,
    }),
  }),
});
