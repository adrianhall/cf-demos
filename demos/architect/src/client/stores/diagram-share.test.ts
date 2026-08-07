import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramShareStore } from "./diagram-share";

afterEach(() => vi.unstubAllGlobals());

describe("useDiagramShareStore", () => {
  it("loads a diagram's publication status", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: { published: true, revision: 2 } }),
            { status: 200 },
          ),
        ),
    );
    const store = useDiagramShareStore();
    await store.load("diagram-1");

    expect(store.status).toEqual({ published: true, revision: 2 });
    expect(store.error).toBe("");
  });

  it("publishing keeps the raw token only when the server returns a fresh one", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            published: true,
            revision: 1,
            token: "raw-token-value",
          }),
          { status: 200 },
        ),
      ),
    );
    const store = useDiagramShareStore();
    await store.publish("diagram-1");

    expect(store.lastToken).toBe("raw-token-value");
    expect(store.status).toEqual({ published: true, revision: 1 });
  });

  it("a republish with no returned token leaves any previous token untouched by the response itself", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ published: true, revision: 2, token: null }),
            { status: 200 },
          ),
        ),
    );
    const store = useDiagramShareStore();
    store.lastToken = "previously-shown-token";
    await store.publish("diagram-1");

    // publish() only ever *sets* lastToken when the server returns a fresh one; a `null` token
    // means "no new token was generated," which this store deliberately treats as "nothing to
    // update" rather than clearing what the owner already copied earlier in this session.
    expect(store.lastToken).toBe("previously-shown-token");
    expect(store.status?.revision).toBe(2);
  });

  it("clears the one-time raw token from memory on request", () => {
    setActivePinia(createPinia());
    const store = useDiagramShareStore();
    store.lastToken = "raw-token-value";
    store.clearLastToken();
    expect(store.lastToken).toBe("");
  });

  it("revoking resets the published status and forgets the token", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const store = useDiagramShareStore();
    store.status = { published: true, revision: 1 };
    store.lastToken = "raw-token-value";
    await store.revoke("diagram-1");

    expect(store.status).toEqual({ published: false });
    expect(store.lastToken).toBe("");
  });

  it("records a user-safe error when publishing fails", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ detail: "Only the diagram's owner can do this." }),
            { status: 403 },
          ),
        ),
    );
    const store = useDiagramShareStore();
    await store.publish("diagram-1");

    expect(store.error).toBe("Only the diagram's owner can do this.");
  });
});
