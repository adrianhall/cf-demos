import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramsStore } from "./diagrams";

afterEach(() => vi.unstubAllGlobals());

describe("useDiagramsStore", () => {
  it("loads the owner's diagrams", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagrams: [
              {
                id: "d-1",
                ownerEmail: "owner@example.com",
                title: "Existing",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      ),
    );
    const store = useDiagramsStore();
    await store.load();
    expect(store.diagrams).toHaveLength(1);
    expect(store.error).toBe("");
  });

  it("records a user-safe error when loading fails", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Not authenticated." }), {
          status: 401,
        }),
      ),
    );
    const store = useDiagramsStore();
    await store.load();
    expect(store.error).toBe("Not authenticated.");
  });

  it("creates a diagram and places it first in the list", async () => {
    setActivePinia(createPinia());
    const created = {
      id: "d-2",
      ownerEmail: "owner@example.com",
      title: "New diagram",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ diagram: created }), { status: 201 }),
        ),
    );
    const store = useDiagramsStore();
    const diagram = await store.create("New diagram", "blank");
    expect(diagram).toEqual(created);
    expect(store.diagrams[0]).toEqual(created);
  });

  it("renames a diagram in place", async () => {
    setActivePinia(createPinia());
    const store = useDiagramsStore();
    store.diagrams = [
      {
        id: "d-1",
        ownerEmail: "owner@example.com",
        title: "Old",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const renamed = { ...store.diagrams[0], title: "New" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ diagram: renamed }))),
    );
    await store.rename("d-1", "New");
    expect(store.diagrams[0].title).toBe("New");
  });
});
