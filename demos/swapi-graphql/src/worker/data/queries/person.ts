import { COLUMNS } from "../tables/person";
import { foreignKeyQuery, placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit person projection reused by the static statements. */
const columns = COLUMNS.map((column) => `person.${column}`).join(", ");

/** Static SQL statements that return people without using `SELECT *`. */
export const PERSON_QUERIES = {
  list: `SELECT ${columns} FROM person ORDER BY name`,
  byId: `SELECT ${columns} FROM person WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM person WHERE id IN (${placeholders(count)})`,
  byFilmIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "person",
        join: "film_person",
        joinEntityColumn: "person_id",
        joinParentColumn: "film_id",
        orderBy: "person.name, person.id",
      },
      count,
      first,
    ),
  byPlanetIds: (count: number, first?: number) =>
    foreignKeyQuery(
      {
        columns,
        entity: "person",
        parentColumn: "homeworld_id",
        orderBy: "person.name, person.id",
      },
      count,
      first,
    ),
  bySpeciesIds: (count: number, first?: number) =>
    foreignKeyQuery(
      {
        columns,
        entity: "person",
        parentColumn: "species_id",
        orderBy: "person.name, person.id",
      },
      count,
      first,
    ),
  byStarshipIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "person",
        join: "person_starship",
        joinEntityColumn: "person_id",
        joinParentColumn: "starship_id",
        orderBy: "person.name, person.id",
      },
      count,
      first,
    ),
  byVehicleIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "person",
        join: "person_vehicle",
        joinEntityColumn: "person_id",
        joinParentColumn: "vehicle_id",
        orderBy: "person.name, person.id",
      },
      count,
      first,
    ),
} as const;
