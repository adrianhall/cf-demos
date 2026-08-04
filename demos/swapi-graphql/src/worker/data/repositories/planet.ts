/**
 * Intentionally naive planet queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { PLANET_QUERIES } from "../queries/planet";
import { mapPlanet, type Planet, type PlanetRow } from "../tables/planet";

/** Returns all planets. @param env Worker bindings. @returns Mapped planets. */
export async function listPlanets(env: AppBindings): Promise<Planet[]> {
  const result = await env.DB.prepare(PLANET_QUERIES.list).all<PlanetRow>();
  return result.results.map(mapPlanet);
}
/** Returns one planet. @param env Worker bindings. @param id Planet id. @returns The planet or null. */
export async function findPlanetById(
  env: AppBindings,
  id: string,
): Promise<Planet | null> {
  const row = await env.DB.prepare(PLANET_QUERIES.byId)
    .bind(id)
    .first<PlanetRow>();
  return row === null ? null : mapPlanet(row);
}
/** Returns planets for one film. @param env Worker bindings. @param filmId Parent film id. @returns Related planets. */
export async function findPlanetsByFilmId(
  env: AppBindings,
  filmId: string,
): Promise<Planet[]> {
  const result = await env.DB.prepare(PLANET_QUERIES.byFilmId)
    .bind(filmId)
    .all<PlanetRow>();
  return result.results.map(mapPlanet);
}
/** Returns a person's nullable homeworld. @param env Worker bindings. @param personId Parent person id. @returns The homeworld or null. */
export async function findPlanetByPersonId(
  env: AppBindings,
  personId: string,
): Promise<Planet | null> {
  const row = await env.DB.prepare(PLANET_QUERIES.byPersonId)
    .bind(personId)
    .first<PlanetRow>();
  return row === null ? null : mapPlanet(row);
}
/** Returns a species' nullable homeworld. @param env Worker bindings. @param speciesId Parent species id. @returns The homeworld or null. */
export async function findPlanetBySpeciesId(
  env: AppBindings,
  speciesId: string,
): Promise<Planet | null> {
  const row = await env.DB.prepare(PLANET_QUERIES.bySpeciesId)
    .bind(speciesId)
    .first<PlanetRow>();
  return row === null ? null : mapPlanet(row);
}
