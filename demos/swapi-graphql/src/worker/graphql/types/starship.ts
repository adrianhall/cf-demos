/** Defines the Starship GraphQL object and its intentionally unbatched relations. */
import { findFilmsByStarshipId } from "../../data/repositories/film";
import { findPeopleByStarshipId } from "../../data/repositories/person";
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
    pilots: t.field({
      type: [personType],
      resolve: (starship, _args, env) =>
        findPeopleByStarshipId(env, starship.id),
    }),
    films: t.field({
      type: [filmType],
      resolve: (starship, _args, env) =>
        findFilmsByStarshipId(env, starship.id),
    }),
  }),
});
