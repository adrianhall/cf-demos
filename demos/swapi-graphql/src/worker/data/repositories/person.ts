/**
 * Batched person queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { PERSON_QUERIES } from "../queries/person";
import { mapPerson, type Person, type PersonRow } from "../tables/person";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all people. @param env Worker bindings. @returns Mapped people. */
export async function listPeople(env: AppBindings): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.list).all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns one person. @param env Worker bindings. @param id Person id. @returns The person or null. */
/** Loads people by primary keys. @param env Worker bindings. @param ids Person ids. @returns Mapped people. */
export function findPeopleByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Person[]> {
  return loadBatch(env, PERSON_QUERIES.byIds(ids.length), ids, mapPerson);
}
/** Loads people grouped by film. @param env Worker bindings. @param ids Film ids. @param first Optional per-film cap. @returns Related people. */
export function findPeopleByFilmIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Person>[]> {
  return loadRelatedBatch(
    env,
    PERSON_QUERIES.byFilmIds(ids.length, first),
    ids,
    first,
    mapPerson,
  );
}
/** Loads residents grouped by planet. @param env Worker bindings. @param ids Planet ids. @param first Optional per-planet cap. @returns Related people. */
export function findPeopleByPlanetIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Person>[]> {
  return loadRelatedBatch(
    env,
    PERSON_QUERIES.byPlanetIds(ids.length, first),
    ids,
    first,
    mapPerson,
  );
}
/** Loads people grouped by species. @param env Worker bindings. @param ids Species ids. @param first Optional per-species cap. @returns Related people. */
export function findPeopleBySpeciesIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Person>[]> {
  return loadRelatedBatch(
    env,
    PERSON_QUERIES.bySpeciesIds(ids.length, first),
    ids,
    first,
    mapPerson,
  );
}
/** Loads pilots grouped by starship. @param env Worker bindings. @param ids Starship ids. @param first Optional per-starship cap. @returns Related people. */
export function findPeopleByStarshipIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Person>[]> {
  return loadRelatedBatch(
    env,
    PERSON_QUERIES.byStarshipIds(ids.length, first),
    ids,
    first,
    mapPerson,
  );
}
/** Loads pilots grouped by vehicle. @param env Worker bindings. @param ids Vehicle ids. @param first Optional per-vehicle cap. @returns Related people. */
export function findPeopleByVehicleIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Person>[]> {
  return loadRelatedBatch(
    env,
    PERSON_QUERIES.byVehicleIds(ids.length, first),
    ids,
    first,
    mapPerson,
  );
}
