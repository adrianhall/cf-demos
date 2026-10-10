import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALICE,
  BOB,
  authenticatedRequest,
  resetChannelDirectory,
} from "./fixtures";

/**
 * Exercises the authenticated channel directory HTTP API against the real workerd D1 binding.
 * No test in this file opens a WebSocket, so it needs no Durable Object eviction between
 * tests — `beforeEach` resetting the D1 table is a complete, deterministic clean slate.
 *
 * Durable Object coordination behavior (WebSocket upgrade, broadcast, history replay, and
 * `destroy()`) is covered separately in `chat-room.test.ts`, which has its own
 * WebSocket-specific lifecycle rules.
 */
describe("Chat Worker HTTP API", () => {
  beforeEach(async () => {
    await resetChannelDirectory();
  });

  it("rejects an unauthenticated API request", async () => {
    const response = await exports.default.fetch(
      new Request("https://chat.example/api/channels"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("lists seeded channels and returns the verified identity", async () => {
    const channels = await authenticatedRequest("/api/channels");
    expect(channels.status).toBe(200);
    expect(await channels.json()).toMatchObject({
      channels: [{ name: "general" }, { name: "random" }],
    });

    const me = await authenticatedRequest("/api/me", {}, BOB);
    expect(await me.json()).toEqual({ email: BOB });
  });

  it("lets any authenticated participant create and remove a channel (no admin role)", async () => {
    const created = await authenticatedRequest(
      "/api/channels",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Deploys" }),
      },
      ALICE,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      channel: { name: "deploys", createdBy: ALICE },
    });

    // A different authenticated user than the creator removes it — proving there is no
    // admin-only restriction on channel management.
    const removed = await authenticatedRequest(
      "/api/channels/deploys",
      { method: "DELETE" },
      BOB,
    );
    expect(removed.status).toBe(204);

    const listing = await authenticatedRequest("/api/channels");
    expect(await listing.json()).toMatchObject({
      channels: [{ name: "general" }, { name: "random" }],
    });
  });

  it("rejects invalid or reserved channel names with RFC 9457 problem details", async () => {
    const reserved = await authenticatedRequest("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api" }),
    });
    expect(reserved.status).toBe(422);
    expect(reserved.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const malformedBody = await authenticatedRequest("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(malformedBody.status).toBe(400);
  });

  it("rejects a non-upgrade request to the room route with a problem-details 400", async () => {
    // No `Upgrade` header at all — this must never reach the Durable Object, so this test
    // never risks creating a real WebSocket.
    const response = await authenticatedRequest("/api/channels/general/ws");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(response.webSocket).toBeNull();
  });

  it("returns 404 for a channel that does not exist, without ever routing to a Durable Object", async () => {
    const deleteMissing = await authenticatedRequest(
      "/api/channels/does-not-exist",
      {
        method: "DELETE",
      },
    );
    expect(deleteMissing.status).toBe(404);

    // A well-formed upgrade request for a name absent from the D1 directory must also 404
    // before ever calling `CHAT_ROOM.getByName(...)`, so this never creates a real WebSocket.
    const upgradeMissing = await authenticatedRequest(
      "/api/channels/does-not-exist/ws",
      {
        headers: { Upgrade: "websocket" },
      },
    );
    expect(upgradeMissing.status).toBe(404);
    expect(upgradeMissing.webSocket).toBeNull();
  });

  it("requires Access before any channel mutation or room upgrade", async () => {
    const unauthenticated = [
      new Request("https://chat.example/api/channels", { method: "POST" }),
      new Request("https://chat.example/api/channels/general", {
        method: "DELETE",
      }),
      new Request("https://chat.example/api/channels/general/ws", {
        headers: { Upgrade: "websocket" },
      }),
    ];
    for (const request of unauthenticated) {
      const response = await exports.default.fetch(request);
      expect(response.status).toBe(401);
      expect(response.webSocket).toBeNull();
    }
  });
});
