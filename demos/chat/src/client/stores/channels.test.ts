import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelsStore, type Channel } from "./channels";

/** A stable channel fixture returned by mocked API responses. */
const general: Channel = {
  createdAt: "2026-07-27T00:00:00.000Z",
  createdBy: "system",
  name: "general",
};

/** Build a JSON response with the requested HTTP status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("useChannelsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the channel directory", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ channels: [general] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChannelsStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/channels");
    expect(store.channels).toEqual([general]);
    expect(store.loading).toBe(false);
  });

  it("stores a problem-detail message when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ detail: "Access expired." }, 401)),
    );
    const store = useChannelsStore();

    await store.load();

    expect(store.error).toBe("Access expired.");
  });

  it("uses a safe message when loading rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useChannelsStore();

    await store.load();

    expect(store.error).toBe("Could not load channels.");
  });

  it("falls back to an HTTP-status message for a non-JSON load failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("upstream error", { status: 502 })),
    );
    const store = useChannelsStore();

    await store.load();

    expect(store.error).toBe("Request failed with status 502.");
  });

  it("adds a channel and reloads the directory from the server", async () => {
    const deploys: Channel = {
      createdAt: "2026-07-27T00:01:00.000Z",
      createdBy: "alice@example.com",
      name: "deploys",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ channel: deploys }, 201))
      .mockResolvedValueOnce(jsonResponse({ channels: [general, deploys] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChannelsStore();

    const created = await store.add("Deploys");

    expect(created).toEqual(deploys);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/channels", {
      body: JSON.stringify({ name: "Deploys" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(store.channels).toEqual([general, deploys]);
  });

  it("throws without reloading when a channel name is rejected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: "Reserved name." }, 422));
    vi.stubGlobal("fetch", fetch);
    const store = useChannelsStore();

    await expect(store.add("api")).rejects.toThrow("Reserved name.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("removes a channel and reloads the directory from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ channels: [general] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChannelsStore();

    await store.remove("deploys");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/channels/deploys", {
      method: "DELETE",
    });
    expect(store.channels).toEqual([general]);
  });

  it("throws without reloading when removal fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: "Not found." }, 404));
    vi.stubGlobal("fetch", fetch);
    const store = useChannelsStore();

    await expect(store.remove("missing")).rejects.toThrow("Not found.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
