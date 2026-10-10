import { COLUMNS } from "../tables/vehicle";
import { placeholders, relationQuery } from "./helpers";

/** Comma-delimited explicit vehicle projection reused by the static statements. */
const columns = COLUMNS.map((column) => `vehicle.${column}`).join(", ");

/** Static SQL statements that return vehicles without using `SELECT *`. */
export const VEHICLE_QUERIES = {
  list: `SELECT ${columns} FROM vehicle ORDER BY name`,
  byId: `SELECT ${columns} FROM vehicle WHERE id = ?`,
  byIds: (count: number) =>
    `SELECT ${columns} FROM vehicle WHERE id IN (${placeholders(count)})`,
  byFilmIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "vehicle",
        join: "film_vehicle",
        joinEntityColumn: "vehicle_id",
        joinParentColumn: "film_id",
        orderBy: "vehicle.name, vehicle.id",
      },
      count,
      first,
    ),
  byPersonIds: (count: number, first?: number) =>
    relationQuery(
      {
        columns,
        entity: "vehicle",
        join: "person_vehicle",
        joinEntityColumn: "vehicle_id",
        joinParentColumn: "person_id",
        orderBy: "vehicle.name, vehicle.id",
      },
      count,
      first,
    ),
} as const;
