/**
 * Batched starship queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { STARSHIP_QUERIES } from "../queries/starship";
import {
  mapStarship,
  type Starship,
  type StarshipRow,
} from "../tables/starship";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all starships. @param env Worker bindings. @returns Mapped starships. */
export async function listStarships(env: AppBindings): Promise<Starship[]> {
  const result = await env.DB.prepare(STARSHIP_QUERIES.list).all<StarshipRow>();
  return result.results.map(mapStarship);
}
/** Returns one starship. @param env Worker bindings. @param id Starship id. @returns The starship or null. */
/** Loads starships by primary keys. @param env Worker bindings. @param ids Starship ids. @returns Mapped starships. */
export function findStarshipsByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Starship[]> {
  return loadBatch(env, STARSHIP_QUERIES.byIds(ids.length), ids, mapStarship);
}
/** Loads starships grouped by film. @param env Worker bindings. @param ids Film ids. @param first Optional per-film cap. @returns Related starships. */
export function findStarshipsByFilmIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Starship>[]> {
  return loadRelatedBatch(
    env,
    STARSHIP_QUERIES.byFilmIds(ids.length, first),
    ids,
    first,
    mapStarship,
  );
}
/** Loads starships grouped by person. @param env Worker bindings. @param ids Person ids. @param first Optional per-person cap. @returns Related starships. */
export function findStarshipsByPersonIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Starship>[]> {
  return loadRelatedBatch(
    env,
    STARSHIP_QUERIES.byPersonIds(ids.length, first),
    ids,
    first,
    mapStarship,
  );
}
