import { describe, expect, it } from "vitest";
import {
  ALICE,
  authenticatedRequest,
  unauthenticatedRequest,
} from "./fixtures";

/**
 * Exercises the authenticated shell built in Phase 1/2 against the real workerd runtime: the
 * whole hostname requires a verified Cloudflare Access identity, and `/api/me` reports it. The
 * streaming `/api/chat` inference endpoint is covered separately once it exists — see
 * docs/05-AI-CHAT.md, Phase 3 and Phase 5.
 */
describe("AI Model Playground Worker", () => {
  it("rejects an unauthenticated request with RFC 9457 problem details", async () => {
    const response = await unauthenticatedRequest("/api/me");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("returns the verified identity for an authenticated request", async () => {
    const response = await authenticatedRequest("/api/me", {}, ALICE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: ALICE });
  });

  it("returns a 404 problem details response for an unknown route", async () => {
    const response = await authenticatedRequest("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
