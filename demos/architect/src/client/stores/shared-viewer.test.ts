import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedViewerStore } from "./shared-viewer";

afterEach(() => vi.unstubAllGlobals());

const document = {
  edges: [],
  nodes: [],
  version: 1 as const,
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe("useSharedViewerStore", () => {
  it("resolves a token and stores the returned snapshot", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url, init) => {
        expect(url).toBe("/shared/resolve");
        expect(JSON.parse(String(init?.body))).toEqual({
          token: "raw-token-value",
        });
        return new Response(
          JSON.stringify({ document, revision: 5, title: "My diagram" }),
          { status: 200 },
        );
      }),
    );
    const store = useSharedViewerStore();
    await store.resolve("raw-token-value");

    expect(store.title).toBe("My diagram");
    expect(store.revision).toBe(5);
    expect(store.document).toEqual(document);
    expect(store.error).toBe("");
  });

  it("records a user-safe error for an unknown or revoked token", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ detail: "This share link is not valid." }),
            { status: 404 },
          ),
        ),
    );
    const store = useSharedViewerStore();
    await store.resolve("raw-token-value");

    expect(store.error).toBe("This share link is not valid.");
    expect(store.document).toBeNull();
  });

  it("records a network-failure message when the request throws", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const store = useSharedViewerStore();
    await store.resolve("raw-token-value");

    expect(store.error).toContain("Could not reach the server");
  });
});
