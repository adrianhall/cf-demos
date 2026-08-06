/** Defines the Planet GraphQL object and its intentionally unbatched relations. */
import { findFilmsByPlanetId } from "../../data/repositories/film";
import { findPeopleByPlanetId } from "../../data/repositories/person";
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
    residents: t.field({
      type: [personType],
      resolve: (planet, _args, env) => findPeopleByPlanetId(env, planet.id),
    }),
    films: t.field({
      type: [filmType],
      resolve: (planet, _args, env) => findFilmsByPlanetId(env, planet.id),
    }),
  }),
});
