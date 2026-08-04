import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import { type AdminUser, useAdminStore } from "./admin";

/** A stable admin user fixture returned by mocked API responses. */
function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    business: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    email: "alice@example.com",
    geo: null,
    isAdmin: false,
    usage: emptyUsageSummary(),
    ...overrides,
  };
}

/** Build a JSON response with the requested HTTP status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("useAdminStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the ranked user table and both segment reports in parallel", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ users: [adminUser()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          report: [{ business: "field", usage: emptyUsageSummary() }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          report: [{ geo: "emea", usage: emptyUsageSummary() }],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/admin/users");
    expect(fetch).toHaveBeenCalledWith("/api/admin/reports/by-business");
    expect(fetch).toHaveBeenCalledWith("/api/admin/reports/by-geo");
    expect(store.users).toEqual([adminUser()]);
    expect(store.byBusiness).toEqual([
      { business: "field", usage: emptyUsageSummary() },
    ]);
    expect(store.byGeo).toEqual([{ geo: "emea", usage: emptyUsageSummary() }]);
    expect(store.loading).toBe(false);
  });

  it("stores a problem-detail message when the users request is rejected (non-administrator)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { detail: "This route requires this demo's administrator role." },
            403,
          ),
        ),
    );
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe(
      "This route requires this demo's administrator role.",
    );
    expect(store.users).toEqual([]);
  });

  it("stores a problem-detail message when the by-business report request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ users: [] }))
        .mockResolvedValueOnce(
          jsonResponse({ detail: "Gateway timeout." }, 504),
        )
        .mockResolvedValueOnce(jsonResponse({ report: [] })),
    );
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Gateway timeout.");
  });

  it("stores a problem-detail message when the by-geo report request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ users: [] }))
        .mockResolvedValueOnce(jsonResponse({ report: [] }))
        .mockResolvedValueOnce(
          jsonResponse({ detail: "Service unavailable." }, 503),
        ),
    );
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Service unavailable.");
  });

  it("falls back to a status-code message when a failed response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
    );
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Request failed with status 500.");
  });

  it("uses a safe message when loading rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Could not load the admin console.");
  });

  it("updates a user's metadata with a PATCH request and reloads every view from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ user: adminUser({ business: "leadership" }) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ users: [adminUser({ business: "leadership" })] }),
      )
      .mockResolvedValueOnce(jsonResponse({ report: [] }))
      .mockResolvedValueOnce(jsonResponse({ report: [] }));
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.updateMetadata("alice@example.com", "leadership", "apac");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/admin/users/alice%40example.com",
      {
        body: JSON.stringify({ business: "leadership", geo: "apac" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(store.users).toEqual([adminUser({ business: "leadership" })]);
  });

  it("stores a problem-detail message when the update is rejected (invalid value)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            detail:
              "business must be one of: field, product, leadership, or null.",
          },
          400,
        ),
      ),
    );
    const store = useAdminStore();

    await store.updateMetadata(
      "alice@example.com",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the store's own rejection path with a value the type system would otherwise prevent.
      "not-a-real-segment" as any,
      null,
    );

    expect(store.error).toBe(
      "business must be one of: field, product, leadership, or null.",
    );
  });

  it("falls back to a generic message when the update rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network exploded"));
    const store = useAdminStore();

    await store.updateMetadata("alice@example.com", null, null);

    expect(store.error).toBe("Could not update this user's metadata.");
  });
});
