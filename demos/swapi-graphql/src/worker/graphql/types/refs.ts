/** Creates concrete Pothos references so cyclic SWAPI relations remain type-safe. */
import type { Film } from "../../data/tables/film";
import type { Person } from "../../data/tables/person";
import type { Planet } from "../../data/tables/planet";
import type { Species } from "../../data/tables/species";
import type { Starship } from "../../data/tables/starship";
import type { Vehicle } from "../../data/tables/vehicle";
import { builder } from "../builder";

/** Pothos reference for a Film object. */
export const filmType = builder.objectRef<Film>("Film");

/** Pothos reference for a Person object. */
export const personType = builder.objectRef<Person>("Person");

/** Pothos reference for a Planet object. */
export const planetType = builder.objectRef<Planet>("Planet");

/** Pothos reference for a Species object. */
export const speciesType = builder.objectRef<Species>("Species");

/** Pothos reference for a Starship object. */
export const starshipType = builder.objectRef<Starship>("Starship");

/** Pothos reference for a Vehicle object. */
export const vehicleType = builder.objectRef<Vehicle>("Vehicle");
