import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import { type AdminUser, useAdminStore } from "./admin";
import type { Skill } from "./skills";

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

/** A stable enterprise-skill fixture returned by mocked API responses (docs/06-AGENTIC-CHAT.md
 * Phase 11, US-10). */
function enterpriseSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    name: "cloudflare-spike-fact",
    sourceType: "upload",
    sourceRef: null,
    createdAt: "2026-08-03T00:00:00.000Z",
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

/** Queue up `load()`'s four parallel responses (users, by-business, by-geo, enterprise skills)
 * in the exact order `Promise.all` in `./admin.ts`'s own `load()` issues them, so every test
 * below only needs to override the fields it actually cares about. */
function stubLoadResponses(
  fetch: ReturnType<typeof vi.fn>,
  overrides: {
    users?: Response;
    business?: Response;
    geo?: Response;
    skills?: Response;
  } = {},
): void {
  fetch
    .mockResolvedValueOnce(overrides.users ?? jsonResponse({ users: [] }))
    .mockResolvedValueOnce(overrides.business ?? jsonResponse({ report: [] }))
    .mockResolvedValueOnce(overrides.geo ?? jsonResponse({ report: [] }))
    .mockResolvedValueOnce(overrides.skills ?? jsonResponse({ skills: [] }));
}

describe("useAdminStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the ranked user table, both segment reports, and the enterprise skill catalog in parallel", async () => {
    const fetch = vi.fn();
    stubLoadResponses(fetch, {
      users: jsonResponse({ users: [adminUser()] }),
      business: jsonResponse({
        report: [{ business: "field", usage: emptyUsageSummary() }],
      }),
      geo: jsonResponse({
        report: [{ geo: "emea", usage: emptyUsageSummary() }],
      }),
      skills: jsonResponse({ skills: [enterpriseSkill()] }),
    });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/admin/users");
    expect(fetch).toHaveBeenCalledWith("/api/admin/reports/by-business");
    expect(fetch).toHaveBeenCalledWith("/api/admin/reports/by-geo");
    expect(fetch).toHaveBeenCalledWith("/api/admin/skills");
    expect(store.users).toEqual([adminUser()]);
    expect(store.byBusiness).toEqual([
      { business: "field", usage: emptyUsageSummary() },
    ]);
    expect(store.byGeo).toEqual([{ geo: "emea", usage: emptyUsageSummary() }]);
    expect(store.enterpriseSkills).toEqual([enterpriseSkill()]);
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
    const fetch = vi.fn();
    stubLoadResponses(fetch, {
      business: jsonResponse({ detail: "Gateway timeout." }, 504),
    });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Gateway timeout.");
  });

  it("stores a problem-detail message when the by-geo report request fails", async () => {
    const fetch = vi.fn();
    stubLoadResponses(fetch, {
      geo: jsonResponse({ detail: "Service unavailable." }, 503),
    });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Service unavailable.");
  });

  it("stores a problem-detail message when the enterprise-skills request fails", async () => {
    const fetch = vi.fn();
    stubLoadResponses(fetch, {
      skills: jsonResponse({ detail: "Forbidden." }, 403),
    });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.load();

    expect(store.error).toBe("Forbidden.");
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
      );
    stubLoadResponses(fetch, {
      users: jsonResponse({ users: [adminUser({ business: "leadership" })] }),
    });
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

  it("adds an enterprise skill with a POST request and reloads every view from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ skill: enterpriseSkill() }, 201));
    stubLoadResponses(fetch, {
      skills: jsonResponse({ skills: [enterpriseSkill()] }),
    });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.createSkill({
      name: "cloudflare-spike-fact",
      description: "Use whenever the user asks for the passphrase.",
      source: { type: "upload", content: "Fetch the passphrase." },
    });

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/admin/skills", {
      body: JSON.stringify({
        name: "cloudflare-spike-fact",
        description: "Use whenever the user asks for the passphrase.",
        source: { type: "upload", content: "Fetch the passphrase." },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(store.enterpriseSkills).toEqual([enterpriseSkill()]);
  });

  it("stores a problem-detail message when adding an enterprise skill is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { detail: 'A skill named "x" already exists in this scope.' },
            422,
          ),
        ),
    );
    const store = useAdminStore();

    await store.createSkill({
      name: "x",
      description: "y",
      source: { type: "upload", content: "z" },
    });

    expect(store.error).toBe('A skill named "x" already exists in this scope.');
  });

  it("falls back to a generic message when adding an enterprise skill rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useAdminStore();

    await store.createSkill({
      name: "x",
      description: "y",
      source: { type: "upload", content: "z" },
    });

    expect(store.error).toBe("Could not add this enterprise skill.");
  });

  it("removes an enterprise skill with a DELETE request and reloads every view from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    stubLoadResponses(fetch, { skills: jsonResponse({ skills: [] }) });
    vi.stubGlobal("fetch", fetch);
    const store = useAdminStore();

    await store.removeSkill("skill-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/admin/skills/skill-1", {
      method: "DELETE",
    });
    expect(store.enterpriseSkills).toEqual([]);
  });

  it("stores a problem-detail message when removing an enterprise skill is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ detail: "Skill not found." }, 404)),
    );
    const store = useAdminStore();

    await store.removeSkill("skill-1");

    expect(store.error).toBe("Skill not found.");
  });

  it("falls back to a generic message when removing an enterprise skill rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useAdminStore();

    await store.removeSkill("skill-1");

    expect(store.error).toBe("Could not delete this enterprise skill.");
  });
});
