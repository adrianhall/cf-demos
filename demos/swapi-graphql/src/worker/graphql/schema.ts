/** Assembles the read-only SWAPI GraphQL schema. */
import { findFilmById, listFilms } from "../data/repositories/film";
import { findPersonById, listPeople } from "../data/repositories/person";
import { findPlanetById, listPlanets } from "../data/repositories/planet";
import { findSpeciesById, listSpecies } from "../data/repositories/species";
import { findStarshipById, listStarships } from "../data/repositories/starship";
import { findVehicleById, listVehicles } from "../data/repositories/vehicle";
import { builder } from "./builder";
import "./types/film";
import "./types/person";
import "./types/planet";
import "./types/species";
import "./types/starship";
import "./types/vehicle";
import {
  filmType,
  personType,
  planetType,
  speciesType,
  starshipType,
  vehicleType,
} from "./types/refs";

builder.queryType({
  fields: (t) => ({
    films: t.field({
      type: [filmType],
      resolve: (_root, _args, env) => listFilms(env),
    }),
    film: t.field({
      type: filmType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findFilmById(env, id),
    }),
    people: t.field({
      type: [personType],
      resolve: (_root, _args, env) => listPeople(env),
    }),
    person: t.field({
      type: personType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findPersonById(env, id),
    }),
    planets: t.field({
      type: [planetType],
      resolve: (_root, _args, env) => listPlanets(env),
    }),
    planet: t.field({
      type: planetType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findPlanetById(env, id),
    }),
    speciesList: t.field({
      type: [speciesType],
      resolve: (_root, _args, env) => listSpecies(env),
    }),
    species: t.field({
      type: speciesType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findSpeciesById(env, id),
    }),
    starships: t.field({
      type: [starshipType],
      resolve: (_root, _args, env) => listStarships(env),
    }),
    starship: t.field({
      type: starshipType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findStarshipById(env, id),
    }),
    vehicles: t.field({
      type: [vehicleType],
      resolve: (_root, _args, env) => listVehicles(env),
    }),
    vehicle: t.field({
      type: vehicleType,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_root, { id }, env) => findVehicleById(env, id),
    }),
  }),
});

/** Executable schema containing only the SWAPI Query root. */
export const schema = builder.toSchema();
