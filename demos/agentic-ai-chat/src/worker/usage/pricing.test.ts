import { describe, expect, it } from "vitest";
import { estimateCostUsd, modelIdForRoute } from "./pricing";

describe("modelIdForRoute", () => {
  it("resolves the basic route to gemma-4-26b-a4b-it", () => {
    expect(modelIdForRoute("basic")).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("resolves the reasoning route to deepseek-r1-distill-qwen-32b", () => {
    expect(modelIdForRoute("reasoning")).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
  });
});

describe("estimateCostUsd", () => {
  it("computes the basic model's cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("basic"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(0.1 + 0.3, 10);
  });

  it("computes the reasoning model's cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("reasoning"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(0.497 + 4.881, 10);
  });

  it("scales linearly with token counts below one million", () => {
    const cost = estimateCostUsd(modelIdForRoute("basic"), 500, 200);

    expect(cost).toBeCloseTo((500 * 0.1 + 200 * 0.3) / 1_000_000, 12);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd(modelIdForRoute("basic"), 0, 0)).toBe(0);
  });

  it("returns 0 for an unrecognized model id rather than throwing", () => {
    expect(estimateCostUsd("@cf/unknown/model", 1_000, 1_000)).toBe(0);
  });
});
