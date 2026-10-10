import { describe, expect, it } from "vitest";
import { MAX_RELATION_FIRST, relationFirst } from "./relations";
import { relatedParentId } from "../data/repositories/batch";

describe("relationFirst", () => {
  it("allows an omitted limit", () => {
    expect(relationFirst(undefined)).toBeUndefined();
  });

  it("allows values in the documented range", () => {
    expect(relationFirst(1)).toBe(1);
    expect(relationFirst(MAX_RELATION_FIRST)).toBe(MAX_RELATION_FIRST);
  });

  it.each([0, -1, MAX_RELATION_FIRST + 1])(
    "rejects invalid limit %d",
    (first) => {
      expect(() => relationFirst(first)).toThrow(
        "first must be between 1 and 100",
      );
    },
  );
});

describe("relatedParentId", () => {
  it("rejects an entity without a projected parent key", () => {
    expect(() => relatedParentId({})).toThrow(
      "Relationship query did not return parent_id",
    );
  });
});
