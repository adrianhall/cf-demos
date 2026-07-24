import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

/** Find the first shared Access policy matching a request path. */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("Access path policies", () => {
  it.each(["/", "/admin", "/admin/settings", "/index.html"])(
    "protects page path %s by default",
    (path) => {
      expect(policyFor(path)).toBeUndefined();
    },
  );

  it("protects the management API without redirecting fetch requests", () => {
    expect(policyFor("/api/links/example")).toMatchObject({
      authenticate: true,
      redirect: false,
    });
  });

  it.each(["/l", "/l/example"])("allows public redirect path %s", (path) => {
    expect(policyFor(path)).toMatchObject({ authenticate: false });
  });

  it("does not mistake other paths beginning with l for redirects", () => {
    expect(policyFor("/login")).toBeUndefined();
  });
});
