/**
 * Intentionally naive species queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { SPECIES_QUERIES } from "../queries/species";
import { mapSpecies, type Species, type SpeciesRow } from "../tables/species";

/** Returns all species. @param env Worker bindings. @returns Mapped species. */
export async function listSpecies(env: AppBindings): Promise<Species[]> {
  const result = await env.DB.prepare(SPECIES_QUERIES.list).all<SpeciesRow>();
  return result.results.map(mapSpecies);
}
/** Returns one species. @param env Worker bindings. @param id Species id. @returns The species or null. */
export async function findSpeciesById(
  env: AppBindings,
  id: string,
): Promise<Species | null> {
  const row = await env.DB.prepare(SPECIES_QUERIES.byId)
    .bind(id)
    .first<SpeciesRow>();
  return row === null ? null : mapSpecies(row);
}
/** Returns species for one film. @param env Worker bindings. @param filmId Parent film id. @returns Related species. */
export async function findSpeciesByFilmId(
  env: AppBindings,
  filmId: string,
): Promise<Species[]> {
  const result = await env.DB.prepare(SPECIES_QUERIES.byFilmId)
    .bind(filmId)
    .all<SpeciesRow>();
  return result.results.map(mapSpecies);
}
/** Returns a person's nullable species. @param env Worker bindings. @param personId Parent person id. @returns The species or null. */
export async function findSpeciesByPersonId(
  env: AppBindings,
  personId: string,
): Promise<Species | null> {
  const row = await env.DB.prepare(SPECIES_QUERIES.byPersonId)
    .bind(personId)
    .first<SpeciesRow>();
  return row === null ? null : mapSpecies(row);
}
