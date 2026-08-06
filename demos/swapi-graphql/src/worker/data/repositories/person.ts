/**
 * Intentionally naive person queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { PERSON_QUERIES } from "../queries/person";
import { mapPerson, type Person, type PersonRow } from "../tables/person";

/** Returns all people. @param env Worker bindings. @returns Mapped people. */
export async function listPeople(env: AppBindings): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.list).all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns one person. @param env Worker bindings. @param id Person id. @returns The person or null. */
export async function findPersonById(
  env: AppBindings,
  id: string,
): Promise<Person | null> {
  const row = await env.DB.prepare(PERSON_QUERIES.byId)
    .bind(id)
    .first<PersonRow>();
  return row === null ? null : mapPerson(row);
}
/** Returns people for one film. @param env Worker bindings. @param filmId Parent film id. @returns Related people. */
export async function findPeopleByFilmId(
  env: AppBindings,
  filmId: string,
): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.byFilmId)
    .bind(filmId)
    .all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns residents of one planet. @param env Worker bindings. @param planetId Parent planet id. @returns Related people. */
export async function findPeopleByPlanetId(
  env: AppBindings,
  planetId: string,
): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.byPlanetId)
    .bind(planetId)
    .all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns people of one species. @param env Worker bindings. @param speciesId Parent species id. @returns Related people. */
export async function findPeopleBySpeciesId(
  env: AppBindings,
  speciesId: string,
): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.bySpeciesId)
    .bind(speciesId)
    .all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns pilots of one starship. @param env Worker bindings. @param starshipId Parent starship id. @returns Related people. */
export async function findPeopleByStarshipId(
  env: AppBindings,
  starshipId: string,
): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.byStarshipId)
    .bind(starshipId)
    .all<PersonRow>();
  return result.results.map(mapPerson);
}
/** Returns pilots of one vehicle. @param env Worker bindings. @param vehicleId Parent vehicle id. @returns Related people. */
export async function findPeopleByVehicleId(
  env: AppBindings,
  vehicleId: string,
): Promise<Person[]> {
  const result = await env.DB.prepare(PERSON_QUERIES.byVehicleId)
    .bind(vehicleId)
    .all<PersonRow>();
  return result.results.map(mapPerson);
}
