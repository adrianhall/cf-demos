import { describe, expect, it } from "vitest";
import { estimateCostUsd, modelIdForRoute, tierForBusiness } from "./pricing";

describe("tierForBusiness", () => {
  it("resolves 'field' to the field tier", () => {
    expect(tierForBusiness("field")).toBe("field");
  });

  it("resolves 'product' and 'leadership' to the strong tier, mirroring the conditional's false branch", () => {
    expect(tierForBusiness("product")).toBe("strong");
    expect(tierForBusiness("leadership")).toBe("strong");
  });

  it("resolves an unset business to the strong tier, exactly like a non-'field' value", () => {
    expect(tierForBusiness(null)).toBe("strong");
  });
});

describe("modelIdForRoute", () => {
  it("resolves the basic route's field tier to gemma-4-26b-a4b-it", () => {
    expect(modelIdForRoute("basic", "field")).toBe(
      "@cf/google/gemma-4-26b-a4b-it",
    );
  });

  it("resolves the basic route's strong tier to glm-5.2", () => {
    expect(modelIdForRoute("basic", "leadership")).toBe("@cf/zai-org/glm-5.2");
    expect(modelIdForRoute("basic", "product")).toBe("@cf/zai-org/glm-5.2");
    expect(modelIdForRoute("basic", null)).toBe("@cf/zai-org/glm-5.2");
  });

  it("resolves the reasoning route's field tier to qwen2.5-coder-32b-instruct", () => {
    expect(modelIdForRoute("reasoning", "field")).toBe(
      "@cf/qwen/qwen2.5-coder-32b-instruct",
    );
  });

  it("resolves the reasoning route's strong tier to deepseek-r1-distill-qwen-32b", () => {
    expect(modelIdForRoute("reasoning", "leadership")).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
    expect(modelIdForRoute("reasoning", null)).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
  });
});

describe("estimateCostUsd", () => {
  it("computes the basic route's field-tier model cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("basic", "field"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(0.1 + 0.3, 10);
  });

  it("computes the basic route's strong-tier model cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("basic", "leadership"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(1.4 + 4.4, 10);
  });

  it("computes the reasoning route's field-tier model cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("reasoning", "field"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(0.66 + 1.0, 10);
  });

  it("computes the reasoning route's strong-tier model cost from its published per-million-token rates", () => {
    const cost = estimateCostUsd(
      modelIdForRoute("reasoning", "leadership"),
      1_000_000,
      1_000_000,
    );

    expect(cost).toBeCloseTo(0.497 + 4.881, 10);
  });

  it("scales linearly with token counts below one million", () => {
    const cost = estimateCostUsd(modelIdForRoute("basic", "field"), 500, 200);

    expect(cost).toBeCloseTo((500 * 0.1 + 200 * 0.3) / 1_000_000, 12);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd(modelIdForRoute("basic", "field"), 0, 0)).toBe(0);
  });

  it("returns 0 for an unrecognized model id rather than throwing", () => {
    expect(estimateCostUsd("@cf/unknown/model", 1_000, 1_000)).toBe(0);
  });
});
