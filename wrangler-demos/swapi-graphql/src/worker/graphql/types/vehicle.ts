/** Defines the Vehicle GraphQL object and its batched relationship fields. */
import { RELATION_LOADER_MAX_BATCH_SIZE } from "../../data/queries/helpers";
import { relatedParentId } from "../../data/repositories/batch";
import { relationFirst } from "../relations";
import { findFilmsByVehicleIds } from "../../data/repositories/film";
import { findPeopleByVehicleIds } from "../../data/repositories/person";
import { filmType, personType, vehicleType } from "./refs";

vehicleType.implement({
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
    vehicleClass: t.exposeString("vehicleClass"),
    created: t.exposeString("created"),
    edited: t.exposeString("edited"),
    url: t.exposeString("url"),
    pilots: t.loadableGroup({
      type: personType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findPeopleByVehicleIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (vehicle) => vehicle.id,
    }),
    films: t.loadableGroup({
      type: filmType,
      args: { first: t.arg.int() },
      byPath: true,
      loaderOptions: { maxBatchSize: RELATION_LOADER_MAX_BATCH_SIZE },
      load: (ids, env, args) =>
        findFilmsByVehicleIds(env, ids.map(String), relationFirst(args.first)),
      group: relatedParentId,
      resolve: (vehicle) => vehicle.id,
    }),
  }),
});
