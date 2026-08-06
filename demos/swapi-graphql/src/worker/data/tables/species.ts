/** Columns selected from the `species` table. */
export const COLUMNS = [
  "id",
  "name",
  "classification",
  "designation",
  "average_height",
  "skin_colors",
  "hair_colors",
  "eye_colors",
  "average_lifespan",
  "homeworld_id",
  "language",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `species` table. */
export interface SpeciesRow {
  id: string;
  name: string;
  classification: string;
  designation: string;
  average_height: string;
  skin_colors: string;
  hair_colors: string;
  eye_colors: string;
  average_lifespan: string;
  homeworld_id: string | null;
  language: string;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a species. */
export interface Species {
  id: string;
  name: string;
  classification: string;
  designation: string;
  averageHeight: string;
  skinColors: string;
  hairColors: string;
  eyeColors: string;
  averageLifespan: string;
  homeworldId: string | null;
  language: string;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the species domain representation. @param row D1 result row. @returns A species. */
export function mapSpecies(row: SpeciesRow): Species {
  return {
    id: row.id,
    name: row.name,
    classification: row.classification,
    designation: row.designation,
    averageHeight: row.average_height,
    skinColors: row.skin_colors,
    hairColors: row.hair_colors,
    eyeColors: row.eye_colors,
    averageLifespan: row.average_lifespan,
    homeworldId: row.homeworld_id,
    language: row.language,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
