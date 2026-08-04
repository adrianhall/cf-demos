/** Defines the Film GraphQL object and its intentionally unbatched relations. */
import { findPeopleByFilmId } from "../../data/repositories/person";
import { findPlanetsByFilmId } from "../../data/repositories/planet";
import { findSpeciesByFilmId } from "../../data/repositories/species";
import { findStarshipsByFilmId } from "../../data/repositories/starship";
import { findVehiclesByFilmId } from "../../data/repositories/vehicle";
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
    characters: t.field({
      type: [personType],
      resolve: (film, _args, env) => findPeopleByFilmId(env, film.id),
    }),
    planets: t.field({
      type: [planetType],
      resolve: (film, _args, env) => findPlanetsByFilmId(env, film.id),
    }),
    species: t.field({
      type: [speciesType],
      resolve: (film, _args, env) => findSpeciesByFilmId(env, film.id),
    }),
    starships: t.field({
      type: [starshipType],
      resolve: (film, _args, env) => findStarshipsByFilmId(env, film.id),
    }),
    vehicles: t.field({
      type: [vehicleType],
      resolve: (film, _args, env) => findVehiclesByFilmId(env, film.id),
    }),
  }),
});
