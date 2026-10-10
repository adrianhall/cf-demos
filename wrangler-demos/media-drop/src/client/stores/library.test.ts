import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryStore } from "./library";

/** One public API item used by library-store behavior tests. */
const item = {
  contentType: "image/png",
  createdAt: "2026-07-27T12:00:00.000Z",
  id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
  publishedAt: "2026-07-27T12:00:00.000Z",
  sizeBytes: 12,
  status: "published" as const,
  title: "Published image",
  updatedAt: "2026-07-27T12:00:00.000Z",
};

describe("library store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads a public listing and clears the loading state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ media: [item] }));
    vi.stubGlobal("fetch", fetchMock);
    const store = useLibraryStore();

    await store.load();

    expect(fetchMock).toHaveBeenCalledWith("/api/library");
    expect(store.media).toEqual([item]);
    expect(store.loading).toBe(false);
  });

  it("reports RFC 9457 and network failures without leaving loading active", async () => {
    const store = useLibraryStore();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ detail: "Library unavailable" }, { status: 503 }),
        ),
    );

    await store.load();
    expect(store.error).toBe("Library unavailable");
    expect(store.loading).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    await store.load();
    expect(store.error).toBe("Could not load the library.");
  });

  it("loads detail media and returns null with a status fallback on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ media: item }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = useLibraryStore();

    await expect(store.loadItem(item.id)).resolves.toEqual(item);
    await expect(store.loadItem(item.id)).resolves.toBeNull();
    expect(store.error).toBe("Request failed (404).");
    expect(store.loading).toBe(false);
  });

  it("records playback without surfacing an intentional telemetry failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const store = useLibraryStore();

    await expect(store.recordPlay(item.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/library/${item.id}/play`),
      { keepalive: true, method: "POST" },
    );
  });
});
