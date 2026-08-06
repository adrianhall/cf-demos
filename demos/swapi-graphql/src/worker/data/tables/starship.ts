/** Columns selected from the `starship` table. */
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
  "hyperdrive_rating",
  "mglt",
  "starship_class",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `starship` table. */
export interface StarshipRow {
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
  hyperdrive_rating: string;
  mglt: string;
  starship_class: string;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a starship. */
export interface Starship {
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
  hyperdriveRating: string;
  mglt: string;
  starshipClass: string;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the starship domain representation. @param row D1 result row. @returns A starship. */
export function mapStarship(row: StarshipRow): Starship {
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
    hyperdriveRating: row.hyperdrive_rating,
    mglt: row.mglt,
    starshipClass: row.starship_class,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
