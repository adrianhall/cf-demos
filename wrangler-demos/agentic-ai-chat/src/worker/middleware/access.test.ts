import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

/** Return the first shared Access policy matching a request path. */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("Access path policies", () => {
  it.each(["/api/me", "/api/chats", "/api/chats/example"])(
    "requires an Access token for API path %s without redirecting fetch requests",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: false,
      });
    },
  );

  it.each(["/", "/settings", "/nested/page"])(
    "redirects unauthenticated page navigation at %s to Access sign-in",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: true,
      });
    },
  );
});
