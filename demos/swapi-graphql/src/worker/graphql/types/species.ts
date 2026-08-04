/** Defines the Species GraphQL object and its intentionally unbatched relations. */
import { findFilmsBySpeciesId } from "../../data/repositories/film";
import { findPeopleBySpeciesId } from "../../data/repositories/person";
import { findPlanetBySpeciesId } from "../../data/repositories/planet";
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
      resolve: (species, _args, env) => findPlanetBySpeciesId(env, species.id),
    }),
    people: t.field({
      type: [personType],
      resolve: (species, _args, env) => findPeopleBySpeciesId(env, species.id),
    }),
    films: t.field({
      type: [filmType],
      resolve: (species, _args, env) => findFilmsBySpeciesId(env, species.id),
    }),
  }),
});
