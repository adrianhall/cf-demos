import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

/** Find the first shared Access policy matching a request path. */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("Access path policies", () => {
  it.each(["/", "/index.html"])("protects page path %s by default", (path) => {
    expect(policyFor(path)).toBeUndefined();
  });

  it.each(["/admin", "/admin/settings"])(
    "redirects an unauthenticated navigation to %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: true,
      });
    },
  );

  it.each(["/api/links/example", "/api/me"])(
    "protects the management API at %s without redirecting fetch requests",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: false,
      });
    },
  );

  it.each(["/l", "/l/example"])("allows public redirect path %s", (path) => {
    expect(policyFor(path)).toMatchObject({ authenticate: false });
  });

  it("does not mistake other paths beginning with l for redirects", () => {
    expect(policyFor("/login")).toBeUndefined();
  });
});
