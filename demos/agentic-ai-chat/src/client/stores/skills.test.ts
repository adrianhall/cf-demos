import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Skill, useSkillsStore } from "./skills";

/** A stable personal-skill fixture returned by mocked API responses. */
function skill(overrides: Partial<Skill> = {}): Skill {
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

describe("useSkillsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the signed-in identity's own personal skills", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ skills: [skill()] }));
    vi.stubGlobal("fetch", fetch);
    const store = useSkillsStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/skills");
    expect(store.skills).toEqual([skill()]);
    expect(store.loading).toBe(false);
  });

  it("falls back to a status-code message when a failed response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
    );
    const store = useSkillsStore();

    await store.load();

    expect(store.error).toBe("Request failed with status 500.");
  });

  it("stores a problem-detail message when loading is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail: "Unauthorized." }, 401)),
    );
    const store = useSkillsStore();

    await store.load();

    expect(store.error).toBe("Unauthorized.");
    expect(store.skills).toEqual([]);
  });

  it("falls back to a generic message when loading rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useSkillsStore();

    await store.load();

    expect(store.error).toBe("Could not load your skills.");
  });

  it("creates a skill with a POST request and reloads the list", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ skill: skill() }, 201))
      .mockResolvedValueOnce(jsonResponse({ skills: [skill()] }));
    vi.stubGlobal("fetch", fetch);
    const store = useSkillsStore();

    await store.create({
      name: "cloudflare-spike-fact",
      description: "Use whenever the user asks for the passphrase.",
      source: { type: "upload", content: "Fetch the passphrase." },
    });

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/skills", {
      body: JSON.stringify({
        name: "cloudflare-spike-fact",
        description: "Use whenever the user asks for the passphrase.",
        source: { type: "upload", content: "Fetch the passphrase." },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(store.skills).toEqual([skill()]);
  });

  it("stores a problem-detail message when creation is rejected", async () => {
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
    const store = useSkillsStore();

    await store.create({
      name: "x",
      description: "y",
      source: { type: "upload", content: "z" },
    });

    expect(store.error).toBe('A skill named "x" already exists in this scope.');
  });

  it("falls back to a generic message when creation rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useSkillsStore();

    await store.create({
      name: "x",
      description: "y",
      source: { type: "upload", content: "z" },
    });

    expect(store.error).toBe("Could not add this skill.");
  });

  it("deletes a skill with a DELETE request and reloads the list", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ skills: [] }));
    vi.stubGlobal("fetch", fetch);
    const store = useSkillsStore();

    await store.remove("skill-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/skills/skill-1", {
      method: "DELETE",
    });
    expect(store.skills).toEqual([]);
  });

  it("stores a problem-detail message when deletion is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ detail: "Skill not found." }, 404)),
    );
    const store = useSkillsStore();

    await store.remove("skill-1");

    expect(store.error).toBe("Skill not found.");
  });

  it("falls back to a generic message when deletion rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useSkillsStore();

    await store.remove("skill-1");

    expect(store.error).toBe("Could not delete this skill.");
  });
});
