/**
 * Batched film queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { FILM_QUERIES } from "../queries/film";
import { mapFilm, type Film, type FilmRow } from "../tables/film";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all films. @param env Worker bindings. @returns Mapped films. */
export async function listFilms(env: AppBindings): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.list).all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns one film. @param env Worker bindings. @param id Film id. @returns The film or null. */
/** Loads films by primary keys. @param env Worker bindings. @param ids Film ids. @returns Mapped films. */
export function findFilmsByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Film[]> {
  return loadBatch(env, FILM_QUERIES.byIds(ids.length), ids, mapFilm);
}
/** Loads films grouped by person. @param env Worker bindings. @param ids Person ids. @param first Optional per-person cap. @returns Related films. */
export function findFilmsByPersonIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Film>[]> {
  return loadRelatedBatch(
    env,
    FILM_QUERIES.byPersonIds(ids.length, first),
    ids,
    first,
    mapFilm,
  );
}
/** Loads films grouped by planet. @param env Worker bindings. @param ids Planet ids. @param first Optional per-planet cap. @returns Related films. */
export function findFilmsByPlanetIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Film>[]> {
  return loadRelatedBatch(
    env,
    FILM_QUERIES.byPlanetIds(ids.length, first),
    ids,
    first,
    mapFilm,
  );
}
/** Loads films grouped by species. @param env Worker bindings. @param ids Species ids. @param first Optional per-species cap. @returns Related films. */
export function findFilmsBySpeciesIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Film>[]> {
  return loadRelatedBatch(
    env,
    FILM_QUERIES.bySpeciesIds(ids.length, first),
    ids,
    first,
    mapFilm,
  );
}
/** Loads films grouped by starship. @param env Worker bindings. @param ids Starship ids. @param first Optional per-starship cap. @returns Related films. */
export function findFilmsByStarshipIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Film>[]> {
  return loadRelatedBatch(
    env,
    FILM_QUERIES.byStarshipIds(ids.length, first),
    ids,
    first,
    mapFilm,
  );
}
/** Loads films grouped by vehicle. @param env Worker bindings. @param ids Vehicle ids. @param first Optional per-vehicle cap. @returns Related films. */
export function findFilmsByVehicleIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Film>[]> {
  return loadRelatedBatch(
    env,
    FILM_QUERIES.byVehicleIds(ids.length, first),
    ids,
    first,
    mapFilm,
  );
}
