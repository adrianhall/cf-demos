import { describe, expect, it } from "vitest";
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput,
} from "./validation";

describe("validateCreateDiagramInput", () => {
  it("accepts a title with no blueprint", () => {
    expect(validateCreateDiagramInput({ title: "  My diagram  " })).toEqual({
      title: "My diagram",
    });
  });

  it("accepts a title with a known blueprint", () => {
    expect(
      validateCreateDiagramInput({ title: "Site", blueprintId: "static-site" }),
    ).toEqual({ title: "Site", blueprintId: "static-site" });
  });

  it("rejects a missing body", () => {
    expect(() => validateCreateDiagramInput(null)).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => validateCreateDiagramInput({ title: "   " })).toThrow();
  });

  it("rejects an unrecognized blueprintId", () => {
    expect(() =>
      validateCreateDiagramInput({ title: "Site", blueprintId: "nope" }),
    ).toThrow();
  });
});

describe("validateUpdateDiagramInput", () => {
  it("accepts and trims a title", () => {
    expect(validateUpdateDiagramInput({ title: " Renamed " })).toEqual({
      title: "Renamed",
    });
  });

  it("rejects a non-string title", () => {
    expect(() => validateUpdateDiagramInput({ title: 5 })).toThrow();
  });
});

describe("validateDiagramId", () => {
  it("accepts a well-formed UUID", () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(validateDiagramId(id)).toBe(id);
  });

  it("returns a 404 problem for a malformed id, not a 400", () => {
    expect.assertions(1);
    try {
      validateDiagramId("not-a-uuid");
    } catch (error) {
      expect(error).toMatchObject({ problemDetails: { status: 404 } });
    }
  });
});
