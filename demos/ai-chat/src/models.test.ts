import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, findModel, MODEL_CATALOG } from "./models";

describe("MODEL_CATALOG", () => {
  it("contains at least one non-reasoning and one reasoning model", () => {
    expect(
      MODEL_CATALOG.some((descriptor) => descriptor.reasoning === "none"),
    ).toBe(true);
    expect(
      MODEL_CATALOG.some((descriptor) => descriptor.reasoning !== "none"),
    ).toBe(true);
  });

  it("contains at least one entry for each adapter", () => {
    expect(
      MODEL_CATALOG.some((descriptor) => descriptor.adapter === "cf-native"),
    ).toBe(true);
    expect(
      MODEL_CATALOG.some((descriptor) => descriptor.adapter === "openai-chat"),
    ).toBe(true);
  });

  it("has no duplicate model IDs", () => {
    const ids = MODEL_CATALOG.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry's temperature and maxOutputTokens bounds are internally consistent", () => {
    for (const descriptor of MODEL_CATALOG) {
      expect(descriptor.temperature.min).toBeLessThanOrEqual(
        descriptor.temperature.default,
      );
      expect(descriptor.temperature.default).toBeLessThanOrEqual(
        descriptor.temperature.max,
      );
      expect(descriptor.maxOutputTokens.default).toBeLessThanOrEqual(
        descriptor.maxOutputTokens.max,
      );
      expect(descriptor.maxOutputTokens.default).toBeGreaterThan(0);
    }
  });

  it("keeps two models sharing an adapter with genuinely different temperature bounds (spike finding)", () => {
    // Granite and Llama 4 Scout both use the "cf-native" adapter but have different real
    // temperature ceilings (see docs/DECISIONS.md #10) — this guards against someone
    // "simplifying" the catalog back to one shared per-adapter range.
    const granite = findModel("@cf/ibm-granite/granite-4.0-h-micro");
    const scout = findModel("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(granite?.adapter).toBe(scout?.adapter);
    expect(granite?.temperature.max).not.toBe(scout?.temperature.max);
  });
});

describe("findModel", () => {
  it("finds an exact catalog entry", () => {
    expect(findModel("@cf/ibm-granite/granite-4.0-h-micro")?.displayName).toBe(
      "Granite 4.0 H Micro",
    );
  });

  it("returns undefined for an unknown model id", () => {
    expect(findModel("@cf/not-a-real/model")).toBeUndefined();
  });

  it("does not partially match a prefix of a real model id", () => {
    expect(
      findModel("@cf/ibm-granite/granite-4.0-h-micro-extra"),
    ).toBeUndefined();
    expect(findModel("@cf/ibm-granite/granite-4.0-h")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(findModel("")).toBeUndefined();
  });
});

describe("DEFAULT_MODEL_ID", () => {
  it("resolves to a real, non-reasoning catalog entry", () => {
    const descriptor = findModel(DEFAULT_MODEL_ID);
    expect(descriptor).toBeDefined();
    expect(descriptor?.reasoning).toBe("none");
  });
});
