import { describe, expect, it } from "vitest";
import { validateOperationInput } from "./operation-input";

const validEnvelope = {
  operationId: "op-1",
  baseRevision: 0,
  kind: "move_node",
  payload: { nodeId: "a", position: { x: 1, y: 2 } },
};

describe("validateOperationInput", () => {
  it("accepts a well-formed move_node envelope", () => {
    expect(validateOperationInput(validEnvelope)).toEqual(validEnvelope);
  });

  it("accepts every supported kind's minimal payload shape", () => {
    const cases = [
      { kind: "add_node", payload: { node: { id: "n" } } },
      {
        kind: "update_node",
        payload: { nodeId: "n", data: {} },
      },
      { kind: "delete_node", payload: { nodeId: "n" } },
      { kind: "add_edge", payload: { edge: { id: "e" } } },
      { kind: "delete_edge", payload: { edgeId: "e" } },
      { kind: "replace_document", payload: { document: {} } },
    ];
    for (const { kind, payload } of cases) {
      expect(
        validateOperationInput({
          operationId: "op",
          baseRevision: 0,
          kind,
          payload,
        }),
      ).toMatchObject({ kind });
    }
  });

  it("rejects a non-object body", () => {
    expect(() => validateOperationInput("nope")).toThrow();
  });

  it("rejects a missing operationId", () => {
    expect(() =>
      validateOperationInput({ ...validEnvelope, operationId: "" }),
    ).toThrow();
  });

  it("rejects a negative baseRevision", () => {
    expect(() =>
      validateOperationInput({ ...validEnvelope, baseRevision: -1 }),
    ).toThrow();
  });

  it("rejects a non-integer baseRevision", () => {
    expect(() =>
      validateOperationInput({ ...validEnvelope, baseRevision: 1.5 }),
    ).toThrow();
  });

  it("rejects an unsupported kind", () => {
    expect(() =>
      validateOperationInput({ ...validEnvelope, kind: "delete_document" }),
    ).toThrow();
  });

  it("rejects a non-object payload", () => {
    expect(() =>
      validateOperationInput({ ...validEnvelope, payload: "nope" }),
    ).toThrow();
  });

  it("rejects move_node missing a numeric position", () => {
    expect(() =>
      validateOperationInput({
        ...validEnvelope,
        payload: { nodeId: "a", position: { x: "1", y: 2 } },
      }),
    ).toThrow();
  });

  it("rejects delete_node missing nodeId", () => {
    expect(() =>
      validateOperationInput({
        operationId: "op",
        baseRevision: 0,
        kind: "delete_node",
        payload: {},
      }),
    ).toThrow();
  });
});
