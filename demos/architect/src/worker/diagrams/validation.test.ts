import { describe, expect, it } from "vitest";
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateGraphDataInput,
  validateUpdateDiagramInput,
} from "./validation";

describe("validateDiagramId", () => {
  it("accepts a well-formed UUID", () => {
    expect(validateDiagramId("11111111-1111-1111-1111-111111111111")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("rejects a malformed id as not found", () => {
    expect(() => validateDiagramId("not-a-uuid")).toThrow();
  });

  it("rejects an empty id as not found", () => {
    expect(() => validateDiagramId("")).toThrow();
  });
});

describe("validateCreateDiagramInput", () => {
  it("accepts an empty object, leaving every field unset", () => {
    expect(validateCreateDiagramInput({})).toEqual({});
  });

  it("trims and accepts a valid title", () => {
    expect(validateCreateDiagramInput({ title: "  My Diagram  " })).toEqual({
      title: "My Diagram",
    });
  });

  it("rejects an empty title", () => {
    expect(() => validateCreateDiagramInput({ title: "   " })).toThrow();
  });

  it("rejects a non-string title", () => {
    expect(() => validateCreateDiagramInput({ title: 42 })).toThrow();
  });

  it("rejects a title over 255 characters", () => {
    expect(() =>
      validateCreateDiagramInput({ title: "a".repeat(256) }),
    ).toThrow();
  });

  it("accepts a valid description", () => {
    expect(
      validateCreateDiagramInput({ description: "A description" }),
    ).toEqual({ description: "A description" });
  });

  it("rejects a description over 2000 characters", () => {
    expect(() =>
      validateCreateDiagramInput({ description: "a".repeat(2001) }),
    ).toThrow();
  });

  it("rejects a non-string, non-null description", () => {
    expect(() => validateCreateDiagramInput({ description: 42 })).toThrow();
  });

  it("accepts a non-empty blueprintId", () => {
    expect(validateCreateDiagramInput({ blueprintId: "api-gateway" })).toEqual({
      blueprintId: "api-gateway",
    });
  });

  it("rejects an empty blueprintId", () => {
    expect(() => validateCreateDiagramInput({ blueprintId: "  " })).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateCreateDiagramInput("nope")).toThrow();
    expect(() => validateCreateDiagramInput(null)).toThrow();
    expect(() => validateCreateDiagramInput([])).toThrow();
  });
});

describe("validateUpdateDiagramInput", () => {
  it("accepts a title-only update", () => {
    expect(validateUpdateDiagramInput({ title: "New Title" })).toEqual({
      title: "New Title",
    });
  });

  it("accepts a description-only update, including clearing it to null", () => {
    expect(validateUpdateDiagramInput({ description: null })).toEqual({
      description: null,
    });
  });

  it("accepts both fields together", () => {
    expect(
      validateUpdateDiagramInput({ description: "d", title: "t" }),
    ).toEqual({ description: "d", title: "t" });
  });

  it("rejects a body with neither field", () => {
    expect(() => validateUpdateDiagramInput({})).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateUpdateDiagramInput("nope")).toThrow();
  });
});

describe("validateGraphDataInput", () => {
  it("round-trips a well-formed graph", () => {
    const body = {
      graphData: JSON.stringify({
        edges: [{ id: "e1", source: "a", target: "b" }],
        nodes: [{ data: { typeId: "worker" }, id: "a" }, { id: "b" }],
        viewport: { x: 10, y: 20, zoom: 1.5 },
      }),
    };

    expect(JSON.parse(validateGraphDataInput(body))).toEqual({
      edges: [{ id: "e1", source: "a", target: "b" }],
      nodes: [{ data: { typeId: "worker" }, id: "a" }, { id: "b" }],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    });
  });

  it("defaults missing nodes, edges, and viewport", () => {
    const result = JSON.parse(validateGraphDataInput({ graphData: "{}" }));
    expect(result).toEqual({
      edges: [],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it("rejects a non-object request body", () => {
    expect(() => validateGraphDataInput("nope")).toThrow();
    expect(() => validateGraphDataInput(null)).toThrow();
  });

  it("rejects a graphData field that is not a string", () => {
    expect(() => validateGraphDataInput({ graphData: {} })).toThrow();
  });

  it("rejects graphData that is not valid JSON", () => {
    expect(() => validateGraphDataInput({ graphData: "{not json" })).toThrow();
  });

  it("rejects graphData that does not decode to an object", () => {
    expect(() => validateGraphDataInput({ graphData: "[]" })).toThrow();
    expect(() => validateGraphDataInput({ graphData: '"a string"' })).toThrow();
  });

  it("rejects a nodes array containing a non-object element", () => {
    const body = { graphData: JSON.stringify({ nodes: ["not-an-object"] }) };
    expect(() => validateGraphDataInput(body)).toThrow();
  });

  it("rejects a node missing a string id", () => {
    const body = { graphData: JSON.stringify({ nodes: [{}] }) };
    expect(() => validateGraphDataInput(body)).toThrow();
  });

  it("rejects an edges value that is not an array", () => {
    const body = { graphData: JSON.stringify({ edges: "nope" }) };
    expect(() => validateGraphDataInput(body)).toThrow();
  });

  it("rejects a malformed viewport", () => {
    const body = {
      graphData: JSON.stringify({
        viewport: { x: "not-a-number", y: 0, zoom: 1 },
      }),
    };
    expect(() => validateGraphDataInput(body)).toThrow();
  });
});
