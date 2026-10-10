import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

/** Returns the first Access policy that applies to a request path. */
function policyFor(path: string) {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("accessPolicies", () => {
  it("requires an Access identity for the studio API before the public catch-all", () => {
    expect(policyFor("/api/studio/media")).toMatchObject({
      authenticate: true,
      redirect: false,
    });
  });

  it("keeps public library routes bypassed", () => {
    expect(policyFor("/api/library")).toMatchObject({ authenticate: false });
  });
});
