import { describe, expect, it } from "vitest";
import { accessPolicies } from "../access-policies";

/** Find the first shared Access policy matching a request path, most-specific-first. */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe("Access path policies", () => {
  it.each(["/api/webhooks/github", "/api/webhooks/gitlab"])(
    "bypasses Access for the webhook path %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: false });
    },
  );

  it.each(["/api/reviews", "/api/reviews/123", "/api/me"])(
    "requires authentication for the management API at %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: true });
    },
  );

  it.each(["/agents/review-run/123"])(
    "requires authentication for the Agents SDK WebSocket route %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: true });
    },
  );

  it.each(["/", "/reviews", "/reviews/123"])(
    "requires authentication for the SPA shell at %s",
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: true });
    },
  );

  it("matches the webhook policy before the broader /api/ policy for a webhook path", () => {
    const webhookPolicy = policyFor("/api/webhooks/github");
    const apiPolicy = accessPolicies.find(
      (policy) => policy.pattern.source === "^\\/api\\/",
    );
    expect(
      accessPolicies.indexOf(apiPolicy as (typeof accessPolicies)[number]),
    ).toBeGreaterThan(
      accessPolicies.indexOf(webhookPolicy as (typeof accessPolicies)[number]),
    );
  });

  it("does not bypass a path that merely starts with /api/web (not /api/webhooks/)", () => {
    expect(policyFor("/api/webinar")).toMatchObject({ authenticate: true });
  });
});
