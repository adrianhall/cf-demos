import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ShortLink, useLinksStore } from "./links";

const firstLink: ShortLink = {
  code: "first",
  createdAt: "2026-07-24T10:00:00.000Z",
  destination: "https://example.com/first",
  updatedAt: "2026-07-24T10:00:00.000Z",
};

const secondLink: ShortLink = {
  code: "second",
  createdAt: "2026-07-24T11:00:00.000Z",
  destination: "https://example.com/second",
  updatedAt: "2026-07-24T11:00:00.000Z",
};

/** Build a JSON response for a mocked management API request. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("links store", () => {
  it("loads links and clears the loading state", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ links: [firstLink] }));
    const store = useLinksStore();

    await store.load();

    expect(fetchMock).toHaveBeenCalledWith("/api/links", {
      headers: { "Content-Type": "application/json" },
    });
    expect(store.links).toEqual([firstLink]);
    expect(store.loading).toBe(false);
  });

  it("clears the loading state when loading fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "Links unavailable" }, 503),
    );
    const store = useLinksStore();

    await expect(store.load()).rejects.toThrow("Links unavailable");
    expect(store.loading).toBe(false);
  });

  it("creates a link at the beginning of local state", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ link: firstLink }, 201));
    const store = useLinksStore();
    store.links = [secondLink];

    await expect(store.create(firstLink.destination)).resolves.toEqual(
      firstLink,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/links", {
      body: JSON.stringify({ destination: firstLink.destination }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(store.links).toEqual([firstLink, secondLink]);
  });

  it("updates only the matching encoded link", async () => {
    const updated = {
      ...firstLink,
      code: "first/code",
      destination: "https://example.com/updated",
    };
    fetchMock.mockResolvedValue(jsonResponse({ link: updated }));
    const store = useLinksStore();
    store.links = [{ ...firstLink, code: "first/code" }, secondLink];

    await expect(
      store.update("first/code", updated.destination),
    ).resolves.toEqual(updated);

    expect(fetchMock).toHaveBeenCalledWith("/api/links/first%2Fcode", {
      body: JSON.stringify({ destination: updated.destination }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    expect(store.links).toEqual([updated, secondLink]);
  });

  it("deletes only the matching encoded link", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const store = useLinksStore();
    store.links = [{ ...firstLink, code: "first/code" }, secondLink];

    await store.delete("first/code");

    expect(fetchMock).toHaveBeenCalledWith("/api/links/first%2Fcode", {
      method: "DELETE",
    });
    expect(store.links).toEqual([secondLink]);
  });

  it.each([
    [
      { detail: "Detailed failure", title: "Title failure" },
      "Detailed failure",
    ],
    [{ title: "Title failure" }, "Title failure"],
    [{}, "The request could not be completed."],
  ])(
    "uses safe problem details for request failures",
    async (problem, message) => {
      fetchMock.mockResolvedValue(jsonResponse(problem, 400));

      await expect(
        useLinksStore().create(firstLink.destination),
      ).rejects.toThrow(message);
    },
  );

  it("uses a safe fallback when an error response is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 500 }));

    await expect(useLinksStore().load()).rejects.toThrow(
      "The request could not be completed.",
    );
  });

  it("reports a failed delete without changing local state", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ title: "Delete failed" }, 500));
    const store = useLinksStore();
    store.links = [firstLink];

    await expect(store.delete(firstLink.code)).rejects.toThrow("Delete failed");
    expect(store.links).toEqual([firstLink]);
  });
});
