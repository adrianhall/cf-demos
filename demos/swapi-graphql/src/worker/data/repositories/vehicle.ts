/**
 * Intentionally naive vehicle queries. Every relation lookup runs one unbatched
 * D1 statement for one parent id so GraphQL's N+1 behavior remains observable.
 */
import type { AppBindings } from "../../bindings";
import { VEHICLE_QUERIES } from "../queries/vehicle";
import { mapVehicle, type Vehicle, type VehicleRow } from "../tables/vehicle";

/** Returns all vehicles. @param env Worker bindings. @returns Mapped vehicles. */
export async function listVehicles(env: AppBindings): Promise<Vehicle[]> {
  const result = await env.DB.prepare(VEHICLE_QUERIES.list).all<VehicleRow>();
  return result.results.map(mapVehicle);
}
/** Returns one vehicle. @param env Worker bindings. @param id Vehicle id. @returns The vehicle or null. */
export async function findVehicleById(
  env: AppBindings,
  id: string,
): Promise<Vehicle | null> {
  const row = await env.DB.prepare(VEHICLE_QUERIES.byId)
    .bind(id)
    .first<VehicleRow>();
  return row === null ? null : mapVehicle(row);
}
/** Returns vehicles for one film. @param env Worker bindings. @param filmId Parent film id. @returns Related vehicles. */
export async function findVehiclesByFilmId(
  env: AppBindings,
  filmId: string,
): Promise<Vehicle[]> {
  const result = await env.DB.prepare(VEHICLE_QUERIES.byFilmId)
    .bind(filmId)
    .all<VehicleRow>();
  return result.results.map(mapVehicle);
}
/** Returns vehicles piloted by one person. @param env Worker bindings. @param personId Parent person id. @returns Related vehicles. */
export async function findVehiclesByPersonId(
  env: AppBindings,
  personId: string,
): Promise<Vehicle[]> {
  const result = await env.DB.prepare(VEHICLE_QUERIES.byPersonId)
    .bind(personId)
    .all<VehicleRow>();
  return result.results.map(mapVehicle);
}
