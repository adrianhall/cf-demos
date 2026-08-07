import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramMembersStore } from "./diagram-members";

afterEach(() => vi.unstubAllGlobals());

describe("useDiagramMembersStore", () => {
  it("loads a diagram's members", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            members: [
              { email: "owner@example.com", role: "owner" },
              { email: "editor@example.com", role: "editor" },
            ],
          }),
        ),
      ),
    );
    const store = useDiagramMembersStore();
    await store.load("diagram-1");
    expect(store.members).toEqual([
      { email: "owner@example.com", role: "owner" },
      { email: "editor@example.com", role: "editor" },
    ]);
    expect(store.error).toBe("");
  });

  it("records a user-safe error when loading fails", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Diagram not found." }), {
          status: 404,
        }),
      ),
    );
    const store = useDiagramMembersStore();
    await store.load("diagram-1");
    expect(store.members).toEqual([]);
    expect(store.error).toBe("Diagram not found.");
  });
});
