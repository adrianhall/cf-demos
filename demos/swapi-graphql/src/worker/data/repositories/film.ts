/**
 * Intentionally naive film queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { FILM_QUERIES } from "../queries/film";
import { mapFilm, type Film, type FilmRow } from "../tables/film";

/** Returns all films. @param env Worker bindings. @returns Mapped films. */
export async function listFilms(env: AppBindings): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.list).all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns one film. @param env Worker bindings. @param id Film id. @returns The film or null. */
export async function findFilmById(
  env: AppBindings,
  id: string,
): Promise<Film | null> {
  const row = await env.DB.prepare(FILM_QUERIES.byId).bind(id).first<FilmRow>();
  return row === null ? null : mapFilm(row);
}
/** Returns films for one person. @param env Worker bindings. @param personId Parent person id. @returns Related films. */
export async function findFilmsByPersonId(
  env: AppBindings,
  personId: string,
): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.byPersonId)
    .bind(personId)
    .all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns films for one planet. @param env Worker bindings. @param planetId Parent planet id. @returns Related films. */
export async function findFilmsByPlanetId(
  env: AppBindings,
  planetId: string,
): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.byPlanetId)
    .bind(planetId)
    .all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns films for one species. @param env Worker bindings. @param speciesId Parent species id. @returns Related films. */
export async function findFilmsBySpeciesId(
  env: AppBindings,
  speciesId: string,
): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.bySpeciesId)
    .bind(speciesId)
    .all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns films for one starship. @param env Worker bindings. @param starshipId Parent starship id. @returns Related films. */
export async function findFilmsByStarshipId(
  env: AppBindings,
  starshipId: string,
): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.byStarshipId)
    .bind(starshipId)
    .all<FilmRow>();
  return result.results.map(mapFilm);
}
/** Returns films for one vehicle. @param env Worker bindings. @param vehicleId Parent vehicle id. @returns Related films. */
export async function findFilmsByVehicleId(
  env: AppBindings,
  vehicleId: string,
): Promise<Film[]> {
  const result = await env.DB.prepare(FILM_QUERIES.byVehicleId)
    .bind(vehicleId)
    .all<FilmRow>();
  return result.results.map(mapFilm);
}
