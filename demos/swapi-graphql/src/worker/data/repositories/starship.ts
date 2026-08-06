/**
 * Intentionally naive starship queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { STARSHIP_QUERIES } from "../queries/starship";
import {
  mapStarship,
  type Starship,
  type StarshipRow,
} from "../tables/starship";

/** Returns all starships. @param env Worker bindings. @returns Mapped starships. */
export async function listStarships(env: AppBindings): Promise<Starship[]> {
  const result = await env.DB.prepare(STARSHIP_QUERIES.list).all<StarshipRow>();
  return result.results.map(mapStarship);
}
/** Returns one starship. @param env Worker bindings. @param id Starship id. @returns The starship or null. */
export async function findStarshipById(
  env: AppBindings,
  id: string,
): Promise<Starship | null> {
  const row = await env.DB.prepare(STARSHIP_QUERIES.byId)
    .bind(id)
    .first<StarshipRow>();
  return row === null ? null : mapStarship(row);
}
/** Returns starships for one film. @param env Worker bindings. @param filmId Parent film id. @returns Related starships. */
export async function findStarshipsByFilmId(
  env: AppBindings,
  filmId: string,
): Promise<Starship[]> {
  const result = await env.DB.prepare(STARSHIP_QUERIES.byFilmId)
    .bind(filmId)
    .all<StarshipRow>();
  return result.results.map(mapStarship);
}
/** Returns starships piloted by one person. @param env Worker bindings. @param personId Parent person id. @returns Related starships. */
export async function findStarshipsByPersonId(
  env: AppBindings,
  personId: string,
): Promise<Starship[]> {
  const result = await env.DB.prepare(STARSHIP_QUERIES.byPersonId)
    .bind(personId)
    .all<StarshipRow>();
  return result.results.map(mapStarship);
}
