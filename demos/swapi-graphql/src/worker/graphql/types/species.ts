/** Defines the Species GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findFilmsBySpeciesIds } from "../../data/repositories/film";
import { findPeopleBySpeciesIds } from "../../data/repositories/person";
import { filmType, personType, planetType, speciesType } from "./refs";

speciesType.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    classification: t.exposeString("classification"),
    designation: t.exposeString("designation"),
    averageHeight: t.exposeString("averageHeight"),
    skinColors: t.exposeString("skinColors"),
    hairColors: t.exposeString("hairColors"),
    eyeColors: t.exposeString("eyeColors"),
    averageLifespan: t.exposeString("averageLifespan"),
    language: t.exposeString("language"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    homeworld: t.field({
      type: planetType,
      nullable: true,
      resolve: (species) => species.homeworldId,
    }),
    people: t.loadableGroup({
      type: personType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPeopleBySpeciesIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (species) => species.id,
    }),
    films: t.loadableGroup({
      type: filmType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findFilmsBySpeciesIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (species) => species.id,
    }),
  }),
});
