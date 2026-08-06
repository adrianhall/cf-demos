import { describe, expect, it } from "vitest";
import {
  D1_MAX_BOUND_PARAMETERS,
  foreignKeyQuery,
  placeholders,
  RELATION_LOADER_MAX_BATCH_SIZE,
} from "./helpers";

describe("batched D1 query helpers", () => {
  it("leaves a parameter slot for a per-parent limit", () => {
    expect(RELATION_LOADER_MAX_BATCH_SIZE + 1).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
  });

  it("creates only parameter placeholders", () => {
    expect(placeholders(3)).toBe("?, ?, ?");
    expect(() => placeholders(0)).toThrow(RangeError);
  });

  it("applies a windowed per-parent limit to foreign-key batches", () => {
    const sql = foreignKeyQuery(
      {
        columns: "person.id, person.name",
        entity: "person",
        parentColumn: "homeworld_id",
        orderBy: "person.name, person.id",
      },
      2,
      3,
    );

    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("SELECT parent_id, id, name FROM");
    expect(sql).toContain("ORDER BY parent_id, name, id");
  });
});
