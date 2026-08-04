import { describe, expect, it } from "vitest";
import { BUSINESS_VALUES, GEO_VALUES, isBusiness, isGeo } from "./business";

describe("isBusiness", () => {
  it("accepts exactly the three valid business literals", () => {
    expect(isBusiness("field")).toBe(true);
    expect(isBusiness("product")).toBe(true);
    expect(isBusiness("leadership")).toBe(true);
  });

  it("rejects anything else, including null, a close-but-wrong string, and a geo value", () => {
    expect(isBusiness(null)).toBe(false);
    expect(isBusiness(undefined)).toBe(false);
    expect(isBusiness("Field")).toBe(false);
    expect(isBusiness("emea")).toBe(false);
    expect(isBusiness(42)).toBe(false);
    expect(isBusiness("")).toBe(false);
  });
});

describe("BUSINESS_VALUES", () => {
  it("lists every business segment", () => {
    expect(BUSINESS_VALUES).toEqual(["field", "product", "leadership"]);
  });
});

describe("isGeo", () => {
  it("accepts exactly the three valid geo literals", () => {
    expect(isGeo("emea")).toBe(true);
    expect(isGeo("apac")).toBe(true);
    expect(isGeo("americas")).toBe(true);
  });

  it("rejects anything else, including null, a close-but-wrong string, and a business value", () => {
    expect(isGeo(null)).toBe(false);
    expect(isGeo(undefined)).toBe(false);
    expect(isGeo("EMEA")).toBe(false);
    expect(isGeo("field")).toBe(false);
    expect(isGeo(42)).toBe(false);
    expect(isGeo("")).toBe(false);
  });
});

describe("GEO_VALUES", () => {
  it("lists every geo segment", () => {
    expect(GEO_VALUES).toEqual(["emea", "apac", "americas"]);
  });
});
