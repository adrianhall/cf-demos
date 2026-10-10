import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session";

describe("useSessionStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the verified identity returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ email: "alice@example.com" }), {
          status: 200,
        }),
      ),
    );
    const store = useSessionStore();

    await store.load();

    expect(store.email).toBe("alice@example.com");
    expect(store.isAuthenticated).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("clears the identity and exposes a problem-detail message after an API failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Access expired." }), {
          status: 401,
        }),
      ),
    );
    const store = useSessionStore();

    await store.load();

    expect(store.email).toBeNull();
    expect(store.error).toBe("Access expired.");
    expect(store.loading).toBe(false);
  });

  it("falls back to the response status when an error body is not problem details", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("upstream error", { status: 502 })),
    );
    const store = useSessionStore();

    await store.load();

    expect(store.error).toBe("Request failed with status 502.");
  });

  it("uses a safe message when fetch rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useSessionStore();

    await store.load();

    expect(store.error).toBe(
      "Could not verify your Cloudflare Access identity.",
    );
  });
});
