import { exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { describe, expect, it } from "vitest";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Create a request that matches the local Access development-token flow. */
async function authenticatedRequest(
  path: string,
  email = "architect@example.com",
): Promise<Request> {
  const token = await signDevJwt(email);
  return new Request(`http://example.test${path}`, {
    headers: { [JWT_HEADER]: token },
  });
}

describe("Phase 1 Access", () => {
  it("rejects an unauthenticated API request", async () => {
    const response = await exports.default.fetch("http://example.test/api/me");
    expect(response.status).toBe(401);
  });

  it("returns the verified identity for an authenticated API request", async () => {
    const response = await exports.default.fetch(
      await authenticatedRequest("/api/me"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      email: "architect@example.com",
    });
  });

  it("does not allow a public share resolver to bypass API authentication", async () => {
    const response = await exports.default.fetch(
      "http://example.test/api/me?share=public",
    );
    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated future WebSocket upgrade before room routing", async () => {
    const response = await exports.default.fetch(
      new Request(
        "http://example.test/api/diagrams/00000000-0000-0000-0000-000000000000/socket",
        {
          headers: { Connection: "Upgrade", Upgrade: "websocket" },
        },
      ),
    );
    expect(response.status).toBe(401);
  });
});
