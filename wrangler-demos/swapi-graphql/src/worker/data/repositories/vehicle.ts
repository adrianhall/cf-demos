/**
 * Batched vehicle queries used by request-scoped GraphQL DataLoaders.
 */
import type { AppBindings } from "../../bindings";
import { VEHICLE_QUERIES } from "../queries/vehicle";
import { mapVehicle, type Vehicle, type VehicleRow } from "../tables/vehicle";
import { loadBatch, loadRelatedBatch, type Related } from "./batch";

/** Returns all vehicles. @param env Worker bindings. @returns Mapped vehicles. */
export async function listVehicles(env: AppBindings): Promise<Vehicle[]> {
  const result = await env.DB.prepare(VEHICLE_QUERIES.list).all<VehicleRow>();
  return result.results.map(mapVehicle);
}
/** Returns one vehicle. @param env Worker bindings. @param id Vehicle id. @returns The vehicle or null. */
/** Loads vehicles by primary keys. @param env Worker bindings. @param ids Vehicle ids. @returns Mapped vehicles. */
export function findVehiclesByIds(
  env: AppBindings,
  ids: readonly string[],
): Promise<Vehicle[]> {
  return loadBatch(env, VEHICLE_QUERIES.byIds(ids.length), ids, mapVehicle);
}
/** Loads vehicles grouped by film. @param env Worker bindings. @param ids Film ids. @param first Optional per-film cap. @returns Related vehicles. */
export function findVehiclesByFilmIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Vehicle>[]> {
  return loadRelatedBatch(
    env,
    VEHICLE_QUERIES.byFilmIds(ids.length, first),
    ids,
    first,
    mapVehicle,
  );
}
/** Loads vehicles grouped by person. @param env Worker bindings. @param ids Person ids. @param first Optional per-person cap. @returns Related vehicles. */
export function findVehiclesByPersonIds(
  env: AppBindings,
  ids: readonly string[],
  first?: number,
): Promise<Related<Vehicle>[]> {
  return loadRelatedBatch(
    env,
    VEHICLE_QUERIES.byPersonIds(ids.length, first),
    ids,
    first,
    mapVehicle,
  );
}
