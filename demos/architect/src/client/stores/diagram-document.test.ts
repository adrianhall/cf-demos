import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyGraphDocument } from "../../graph/blueprints";
import { useDiagramDocumentStore } from "./diagram-document";

const diagram = {
  id: "d-1",
  ownerEmail: "owner@example.com",
  title: "Diagram",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("useDiagramDocumentStore", () => {
  it("loads a diagram's metadata and document", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagram,
            revision: 3,
            document: emptyGraphDocument,
          }),
        ),
      ),
    );
    const store = useDiagramDocumentStore();
    await store.load("d-1");
    expect(store.diagram).toEqual(diagram);
    expect(store.revision).toBe(3);
    expect(store.document).toEqual(emptyGraphDocument);
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
    const store = useDiagramDocumentStore();
    await store.load("missing");
    expect(store.error).toBe("Diagram not found.");
    expect(store.diagram).toBeNull();
  });

  it("applies an accepted move_node operation and advances the revision", async () => {
    setActivePinia(createPinia());
    const store = useDiagramDocumentStore();
    store.diagram = diagram;
    store.revision = 0;
    store.document = emptyGraphDocument;

    const nextDocument = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "a",
          type: "actor" as const,
          position: { x: 5, y: 5 },
          data: { kind: "external-actor" as const, label: "A" },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { status: "accepted", revision: 1, document: nextDocument },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await store.moveNode("a", { x: 5, y: 5 });

    expect(store.revision).toBe(1);
    expect(store.document).toEqual(nextDocument);
    expect(store.staleNotice).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      baseRevision: 0,
      kind: "move_node",
      payload: { nodeId: "a", position: { x: 5, y: 5 } },
    });
    expect(typeof body.operationId).toBe("string");
  });

  it("resyncs and sets staleNotice without merging on a stale result", async () => {
    setActivePinia(createPinia());
    const store = useDiagramDocumentStore();
    store.diagram = diagram;
    store.revision = 0;
    store.document = emptyGraphDocument;

    const currentDocument = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "server-node",
          type: "actor" as const,
          position: { x: 1, y: 1 },
          data: { kind: "external-actor" as const, label: "Server" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: { status: "stale", revision: 4, document: currentDocument },
          }),
        ),
      ),
    );

    await store.moveNode("missing", { x: 9, y: 9 });

    expect(store.staleNotice).toBe(true);
    expect(store.revision).toBe(4);
    expect(store.document).toEqual(currentDocument);
  });

  it("surfaces a rejected result as a user-visible error", async () => {
    setActivePinia(createPinia());
    const store = useDiagramDocumentStore();
    store.diagram = diagram;
    store.revision = 0;
    store.document = emptyGraphDocument;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              status: "rejected",
              revision: 0,
              document: emptyGraphDocument,
              error: "Node missing does not exist.",
            },
          }),
        ),
      ),
    );

    await store.moveNode("missing", { x: 9, y: 9 });

    expect(store.error).toBe("Node missing does not exist.");
  });

  it("clears the selection when the selected node is deleted", async () => {
    setActivePinia(createPinia());
    const store = useDiagramDocumentStore();
    store.diagram = diagram;
    store.revision = 0;
    store.document = emptyGraphDocument;
    store.select("node", "a");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              status: "accepted",
              revision: 1,
              document: emptyGraphDocument,
            },
          }),
        ),
      ),
    );

    await store.deleteNode("a");

    expect(store.selection).toBeNull();
  });

  it("does nothing when no diagram is loaded", async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = useDiagramDocumentStore();
    await store.moveNode("a", { x: 0, y: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
