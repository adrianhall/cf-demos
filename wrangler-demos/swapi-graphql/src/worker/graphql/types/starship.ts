/** Defines the Starship GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findFilmsByStarshipIds } from "../../data/repositories/film";
import { findPeopleByStarshipIds } from "../../data/repositories/person";
import { filmType, personType, starshipType } from "./refs";

starshipType.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    model: t.exposeString("model"),
    manufacturer: t.exposeString("manufacturer"),
    costInCredits: t.exposeString("costInCredits"),
    length: t.exposeString("length"),
    maxAtmospheringSpeed: t.exposeString("maxAtmospheringSpeed"),
    crew: t.exposeString("crew"),
    passengers: t.exposeString("passengers"),
    cargoCapacity: t.exposeString("cargoCapacity"),
    consumables: t.exposeString("consumables"),
    hyperdriveRating: t.exposeString("hyperdriveRating"),
    mglt: t.exposeString("mglt"),
    starshipClass: t.exposeString("starshipClass"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    pilots: t.loadableGroup({
      type: personType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPeopleByStarshipIds(
          env,
          ids.map(String),
          relationFirst(args.first),
        ),
      group: relatedParentId,
      resolve: (starship) => starship.id,
    }),
    films: t.loadableGroup({
      type: filmType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findFilmsByStarshipIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (starship) => starship.id,
    }),
  }),
});
