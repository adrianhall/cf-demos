/**
 * Batched species queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { SPECIES_QUERIES } from "../queries/species";
import { mapSpecies, type Species, type SpeciesRow } from "../tables/species";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all species. @param env Worker bindings. @returns Mapped species. */
export async function listSpecies(env: AppBindings): Promise<Species[]> {
  const result = await env.DB.prepare(SPECIES_QUERIES.list).all<SpeciesRow>();
  return result.results.map(mapSpecies);
}
/** Returns one species. @param env Worker bindings. @param id Species id. @returns The species or null. */
/** Loads species by primary keys. @param env Worker bindings. @param ids Species ids. @returns Mapped species. */
export function findSpeciesByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Species[]> {
  return loadBatch(env, SPECIES_QUERIES.byIds(ids.length), ids, mapSpecies);
}
/** Loads species grouped by film. @param env Worker bindings. @param ids Film ids. @param first Optional per-film cap. @returns Related species. */
export function findSpeciesByFilmIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Species>[]> {
  return loadRelatedBatch(
    env,
    SPECIES_QUERIES.byFilmIds(ids.length, first),
    ids,
    first,
    mapSpecies,
  );
}
