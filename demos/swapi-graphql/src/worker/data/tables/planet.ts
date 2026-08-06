/** Columns selected from the `planet` table. */
export const COLUMNS = [
  "id",
  "name",
  "rotation_period",
  "orbital_period",
  "diameter",
  "climate",
  "gravity",
  "terrain",
  "surface_water",
  "population",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `planet` table. */
export interface PlanetRow {
  id: string;
  name: string;
  rotation_period: string;
  orbital_period: string;
  diameter: string;
  climate: string;
  gravity: string;
  terrain: string;
  surface_water: string;
  population: string;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a planet. */
export interface Planet {
  /** Parent relationship key populated only by batch relationship queries. */
  parentId?: string;
  id: string;
  name: string;
  rotationPeriod: string;
  orbitalPeriod: string;
  diameter: string;
  climate: string;
  gravity: string;
  terrain: string;
  surfaceWater: string;
  population: string;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the planet domain representation. @param row D1 result row. @returns A planet. */
export function mapPlanet(row: PlanetRow): Planet {
  return {
    id: row.id,
    name: row.name,
    rotationPeriod: row.rotation_period,
    orbitalPeriod: row.orbital_period,
    diameter: row.diameter,
    climate: row.climate,
    gravity: row.gravity,
    terrain: row.terrain,
    surfaceWater: row.surface_water,
    population: row.population,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
