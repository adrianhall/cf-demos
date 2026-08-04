/** Defines the Vehicle GraphQL object and its intentionally unbatched relations. */
import { findFilmsByVehicleId } from "../../data/repositories/film";
import { findPeopleByVehicleId } from "../../data/repositories/person";
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
    pilots: t.field({
      type: [personType],
      resolve: (vehicle, _args, env) => findPeopleByVehicleId(env, vehicle.id),
    }),
    films: t.field({
      type: [filmType],
      resolve: (vehicle, _args, env) => findFilmsByVehicleId(env, vehicle.id),
    }),
  }),
});
