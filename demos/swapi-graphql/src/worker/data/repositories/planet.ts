/**
 * Batched planet queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { PLANET_QUERIES } from "../queries/planet";
import { mapPlanet, type Planet, type PlanetRow } from "../tables/planet";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all planets. @param env Worker bindings. @returns Mapped planets. */
export async function listPlanets(env: AppBindings): Promise<Planet[]> {
  const result = await env.DB.prepare(PLANET_QUERIES.list).all<PlanetRow>();
  return result.results.map(mapPlanet);
}
/** Returns one planet. @param env Worker bindings. @param id Planet id. @returns The planet or null. */
/** Loads planets by primary keys. @param env Worker bindings. @param ids Planet ids. @returns Mapped planets. */
export function findPlanetsByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Planet[]> {
  return loadBatch(env, PLANET_QUERIES.byIds(ids.length), ids, mapPlanet);
}
/** Loads planets grouped by film. @param env Worker bindings. @param ids Film ids. @param first Optional per-film cap. @returns Related planets. */
export function findPlanetsByFilmIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Planet>[]> {
  return loadRelatedBatch(
    env,
    PLANET_QUERIES.byFilmIds(ids.length, first),
    ids,
    first,
    mapPlanet,
  );
}
