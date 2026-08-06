/** Defines the Person GraphQL object and its intentionally unbatched relations. */
import { findFilmsByPersonId } from "../../data/repositories/film";
import { findPlanetByPersonId } from "../../data/repositories/planet";
import { findSpeciesByPersonId } from "../../data/repositories/species";
import { findStarshipsByPersonId } from "../../data/repositories/starship";
import { findVehiclesByPersonId } from "../../data/repositories/vehicle";
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
      resolve: (person, _args, env) => findPlanetByPersonId(env, person.id),
    }),
    species: t.field({
      type: speciesType,
      nullable: true,
      resolve: (person, _args, env) => findSpeciesByPersonId(env, person.id),
    }),
    films: t.field({
      type: [filmType],
      resolve: (person, _args, env) => findFilmsByPersonId(env, person.id),
    }),
    starships: t.field({
      type: [starshipType],
      resolve: (person, _args, env) => findStarshipsByPersonId(env, person.id),
    }),
    vehicles: t.field({
      type: [vehicleType],
      resolve: (person, _args, env) => findVehiclesByPersonId(env, person.id),
    }),
  }),
});
