/** Defines the Planet GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findFilmsByPlanetIds } from "../../data/repositories/film";
import { findPeopleByPlanetIds } from "../../data/repositories/person";
import { filmType, personType, planetType } from "./refs";

planetType.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    rotationPeriod: t.exposeString("rotationPeriod"),
    orbitalPeriod: t.exposeString("orbitalPeriod"),
    diameter: t.exposeString("diameter"),
    climate: t.exposeString("climate"),
    gravity: t.exposeString("gravity"),
    terrain: t.exposeString("terrain"),
    surfaceWater: t.exposeString("surfaceWater"),
    population: t.exposeString("population"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    residents: t.loadableGroup({
      type: personType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPeopleByPlanetIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (planet) => planet.id,
    }),
    films: t.loadableGroup({
      type: filmType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findFilmsByPlanetIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (planet) => planet.id,
    }),
  }),
});
