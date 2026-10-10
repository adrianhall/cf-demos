import { describe, expect, it } from "vitest";
import { validateListUsersQuery } from "./validation";

describe("validateListUsersQuery", () => {
  it("defaults limit and offset when both are omitted", () => {
    expect(validateListUsersQuery({})).toEqual({ limit: 20, offset: 0 });
  });

  it("parses caller-supplied limit and offset", () => {
    expect(validateListUsersQuery({ limit: "5", offset: "10" })).toEqual({
      limit: 5,
      offset: 10,
    });
  });

  it("rejects a non-numeric limit", () => {
    expect(() => validateListUsersQuery({ limit: "abc" })).toThrow();
  });

  it("rejects a non-numeric offset", () => {
    expect(() => validateListUsersQuery({ offset: "-1" })).toThrow();
  });

  it("rejects a limit of zero", () => {
    expect(() => validateListUsersQuery({ limit: "0" })).toThrow();
  });

  it("rejects a limit above the maximum", () => {
    expect(() => validateListUsersQuery({ limit: "101" })).toThrow();
  });

  it("accepts the maximum limit", () => {
    expect(validateListUsersQuery({ limit: "100" })).toEqual({
      limit: 100,
      offset: 0,
    });
  });
});
