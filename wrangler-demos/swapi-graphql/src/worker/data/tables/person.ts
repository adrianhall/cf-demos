/** Columns selected from the `person` table. */
export const COLUMNS = [
  "id",
  "name",
  "height",
  "mass",
  "hair_color",
  "skin_color",
  "eye_color",
  "birth_year",
  "gender",
  "homeworld_id",
  "species_id",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `person` table. */
export interface PersonRow {
  id: string;
  name: string;
  height: string;
  mass: string;
  hair_color: string;
  skin_color: string;
  eye_color: string;
  birth_year: string;
  gender: string;
  homeworld_id: string | null;
  species_id: string | null;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a person. */
export interface Person {
  /** Parent relationship key populated only by batch relationship queries. */
  parentId?: string;
  id: string;
  name: string;
  height: string;
  mass: string;
  hairColor: string;
  skinColor: string;
  eyeColor: string;
  birthYear: string;
  gender: string;
  homeworldId: string | null;
  speciesId: string | null;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the person domain representation. @param row D1 result row. @returns A person. */
export function mapPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    height: row.height,
    mass: row.mass,
    hairColor: row.hair_color,
    skinColor: row.skin_color,
    eyeColor: row.eye_color,
    birthYear: row.birth_year,
    gender: row.gender,
    homeworldId: row.homeworld_id,
    speciesId: row.species_id,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
