/** Columns selected from the `vehicle` table. */
export const COLUMNS = [
  "id",
  "name",
  "model",
  "manufacturer",
  "cost_in_credits",
  "length",
  "max_atmosphering_speed",
  "crew",
  "passengers",
  "cargo_capacity",
  "consumables",
  "vehicle_class",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `vehicle` table. */
export interface VehicleRow {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  cost_in_credits: string;
  length: string;
  max_atmosphering_speed: string;
  crew: string;
  passengers: string;
  cargo_capacity: string;
  consumables: string;
  vehicle_class: string;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a vehicle. */
export interface Vehicle {
  /** Parent relationship key populated only by batch relationship queries. */
  parentId?: string;
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  costInCredits: string;
  length: string;
  maxAtmospheringSpeed: string;
  crew: string;
  passengers: string;
  cargoCapacity: string;
  consumables: string;
  vehicleClass: string;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the vehicle domain representation. @param row D1 result row. @returns A vehicle. */
export function mapVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    manufacturer: row.manufacturer,
    costInCredits: row.cost_in_credits,
    length: row.length,
    maxAtmospheringSpeed: row.max_atmosphering_speed,
    crew: row.crew,
    passengers: row.passengers,
    cargoCapacity: row.cargo_capacity,
    consumables: row.consumables,
    vehicleClass: row.vehicle_class,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
