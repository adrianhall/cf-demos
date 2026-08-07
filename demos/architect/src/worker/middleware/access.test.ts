import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

describe("accessPolicies", () => {
  it("lists public landing and sharing paths explicitly", () => {
    expect(
      accessPolicies.find((policy) => policy.pattern.test("/"))?.authenticate,
    ).toBe(false);
    expect(
      accessPolicies.find((policy) => policy.pattern.test("/share"))
        ?.authenticate,
    ).toBe(false);
    expect(
      accessPolicies.find((policy) => policy.pattern.test("/shared/resolve"))
        ?.authenticate,
    ).toBe(false);
  });

  it("requires authentication for every application and API prefix", () => {
    expect(
      accessPolicies.find((policy) => policy.pattern.test("/app"))
        ?.authenticate,
    ).toBe(true);
    expect(
      accessPolicies.find((policy) => policy.pattern.test("/api/me"))
        ?.authenticate,
    ).toBe(true);
  });
});
