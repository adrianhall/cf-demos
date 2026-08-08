import { describe, expect, it } from "vitest";
import { accessPolicies } from "../../access-policies";

/** Return the first shared Access policy matching a request path. */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("Access path policies", () => {
  it.each(["/api/me", "/api/diagrams", "/api/diagrams/example"])(
    "requires an Access token for API path %s without redirecting fetch requests",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: false,
      });
    },
  );

  it.each(["/app", "/app/", "/app/diagrams/example"])(
    "redirects unauthenticated navigation to the app shell at %s to Access sign-in",
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: true,
      });
    },
  );

  it.each(["/", "/blueprints", "/s/example-token"])(
    "keeps public paths bypassed at %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: false });
    },
  );
});
