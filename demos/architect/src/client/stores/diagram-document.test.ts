import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../collaboration-protocol";
import { emptyGraphDocument } from "../../graph/blueprints";
import type {
  DiagramSocketCallbacks,
  DiagramSocketHandle,
} from "../composables/useDiagramSocket";
import { useDiagramSocket } from "../composables/useDiagramSocket";
import { useArchitectureProposalStore } from "./architecture-proposal";
import { useDiagramDocumentStore } from "./diagram-document";

vi.mock("../composables/useDiagramSocket", () => ({
  useDiagramSocket: vi.fn(),
}));

const diagram = {
  id: "d-1",
  ownerEmail: "owner@example.com",
  title: "Diagram",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Every test replaces `useDiagramSocket` with this fake so the store's WebSocket-driven
 * behavior can be exercised deterministically — the same rationale
 * `demos/chat/src/client/stores/room.test.ts` documents for its own mock `WebSocket` — without
 * this suite needing a real browser socket.
 */
function installFakeSocket(): {
  readonly callbacks: DiagramSocketCallbacks;
  sent: Array<Record<string, unknown>>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const sent: Array<Record<string, unknown>> = [];
  const disconnect = vi.fn();
  const captured: { callbacks: DiagramSocketCallbacks | null } = {
    callbacks: null,
  };
  vi.mocked(useDiagramSocket).mockImplementation((_diagramId, cb) => {
    captured.callbacks = cb;
    return {
      disconnect,
      send: (frame) => sent.push(frame as unknown as Record<string, unknown>),
    } satisfies DiagramSocketHandle;
  });
  return {
    get callbacks(): DiagramSocketCallbacks {
      if (!captured.callbacks) {
        throw new Error("useDiagramSocket was not called yet.");
      }
      return captured.callbacks;
    },
    disconnect,
    sent,
  };
}

/** Load a diagram against a stubbed HTTP metadata fetch, then return the fake socket's handles. */
async function loadWithFakeSocket(
  overrides: { revision?: number; document?: unknown } = {},
) {
  const fake = installFakeSocket();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          diagram,
          document: overrides.document ?? emptyGraphDocument,
          revision: overrides.revision ?? 0,
        }),
      ),
    ),
  );
  const store = useDiagramDocumentStore();
  await store.load("d-1");
  return { fake, store };
}

describe("useDiagramDocumentStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(useDiagramSocket).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads a diagram's directory metadata over HTTP, then opens the live socket", async () => {
    const { store, fake } = await loadWithFakeSocket({ revision: 3 });
    expect(store.diagram).toEqual(diagram);
    expect(store.revision).toBe(3);
    expect(store.document).toEqual(emptyGraphDocument);
    expect(useDiagramSocket).toHaveBeenCalledWith("d-1", expect.anything());
    expect(fake).toBeDefined();
  });

  it("records a user-safe error when the metadata request fails, without opening a socket", async () => {
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
    expect(useDiagramSocket).not.toHaveBeenCalled();
  });

  it("hydrates revision, document, and participants from the initial sync frame", async () => {
    const { store, fake } = await loadWithFakeSocket();
    const syncDocument = { ...emptyGraphDocument, nodes: [] };
    fake.callbacks.onFrame({
      type: "sync",
      revision: 5,
      document: syncDocument,
      participants: [{ email: "owner@example.com", role: "owner" }],
    } satisfies ServerFrame);

    expect(store.revision).toBe(5);
    expect(store.document).toEqual(syncDocument);
    expect(store.participants).toEqual([
      { email: "owner@example.com", role: "owner" },
    ]);
  });

  it("tracks connectionStatus from the socket's onStatusChange callback", async () => {
    const { store, fake } = await loadWithFakeSocket();
    fake.callbacks.onStatusChange("reconnecting");
    expect(store.connectionStatus).toBe("reconnecting");
  });

  it("applies a move_node operation optimistically, then converges on the accepted frame", async () => {
    const withNode = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "a",
          type: "actor" as const,
          position: { x: 0, y: 0 },
          data: { kind: "external-actor" as const, label: "A" },
        },
      ],
    };
    const { store, fake } = await loadWithFakeSocket({
      document: withNode,
      revision: 0,
    });

    const pending = store.moveNode("a", { x: 5, y: 5 });
    // Optimistic: applied locally before any server response.
    expect(store.pending).toBe(true);
    expect(store.document?.nodes[0]?.position).toEqual({ x: 5, y: 5 });
    expect(fake.sent).toHaveLength(1);
    const sentOperation = fake.sent[0]?.operation as {
      operationId: string;
      baseRevision: number;
    };
    expect(sentOperation.baseRevision).toBe(0);

    const nextDocument = {
      ...withNode,
      nodes: [{ ...withNode.nodes[0], position: { x: 5, y: 5 } }],
    };
    fake.callbacks.onFrame({
      type: "operation_accepted",
      operationId: sentOperation.operationId,
      revision: 1,
      duplicate: false,
      document: nextDocument,
    } satisfies ServerFrame);

    const result = await pending;
    expect(result).toMatchObject({ status: "accepted", revision: 1 });
    expect(store.revision).toBe(1);
    expect(store.document).toEqual(nextDocument);
    expect(store.staleNotice).toBe(false);
    expect(store.pending).toBe(false);
  });

  it("reports duplicate: true without treating it as a fresh acceptance", async () => {
    const { store, fake } = await loadWithFakeSocket({
      document: emptyGraphDocument,
      revision: 1,
    });

    const pending = store.addNode({
      id: "a",
      type: "actor",
      position: { x: 0, y: 0 },
      data: { kind: "external-actor", label: "A" },
    });
    const sentFrame = fake.sent[0] as { operation: { operationId: string } };
    const operationId = sentFrame.operation.operationId;
    fake.callbacks.onFrame({
      type: "operation_accepted",
      operationId,
      revision: 1,
      duplicate: true,
      document: emptyGraphDocument,
    } satisfies ServerFrame);

    const result = await pending;
    expect(result).toMatchObject({ status: "duplicate", revision: 1 });
  });

  it("resyncs to the room's authoritative state and sets staleNotice without merging", async () => {
    const { store, fake } = await loadWithFakeSocket({
      document: emptyGraphDocument,
      revision: 0,
    });

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
    const pending = store.moveNode("missing", { x: 9, y: 9 });
    fake.callbacks.onFrame({
      type: "resync",
      revision: 4,
      document: currentDocument,
    } satisfies ServerFrame);

    const result = await pending;
    expect(result).toMatchObject({ status: "stale", revision: 4 });
    expect(store.staleNotice).toBe(true);
    expect(store.revision).toBe(4);
    expect(store.document).toEqual(currentDocument);
    expect(store.pending).toBe(false);
  });

  it("rolls back the optimistic guess and surfaces a rejected result as a user-visible error", async () => {
    const withNode = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "a",
          type: "actor" as const,
          position: { x: 0, y: 0 },
          data: { kind: "external-actor" as const, label: "A" },
        },
      ],
    };
    const { store, fake } = await loadWithFakeSocket({
      document: withNode,
      revision: 1,
    });

    const pending = store.moveNode("a", { x: 9, y: 9 });
    const sentFrame = fake.sent[0] as { operation: { operationId: string } };
    const operationId = sentFrame.operation.operationId;
    fake.callbacks.onFrame({
      type: "operation_rejected",
      operationId,
      error: "Node missing does not exist.",
    } satisfies ServerFrame);

    const result = await pending;
    expect(result).toMatchObject({
      status: "rejected",
      error: "Node missing does not exist.",
    });
    expect(store.error).toBe("Node missing does not exist.");
    // Rolled back to the exact pre-operation document, not left at the optimistic guess.
    expect(store.document).toEqual(withNode);
    expect(store.revision).toBe(1);
  });

  it("clears the selection when the selected node is deleted", async () => {
    const { store, fake } = await loadWithFakeSocket({
      document: emptyGraphDocument,
      revision: 1,
    });
    store.select("node", "a");

    const pending = store.deleteNode("a");
    const sentFrame = fake.sent[0] as { operation: { operationId: string } };
    const operationId = sentFrame.operation.operationId;
    fake.callbacks.onFrame({
      type: "operation_accepted",
      operationId,
      revision: 2,
      duplicate: false,
      document: emptyGraphDocument,
    } satisfies ServerFrame);
    await pending;

    expect(store.selection).toBeNull();
  });

  it("does nothing when no diagram is loaded", async () => {
    setActivePinia(createPinia());
    const store = useDiagramDocumentStore();
    const result = await store.moveNode("a", { x: 0, y: 0 });
    expect(result).toBeUndefined();
    expect(useDiagramSocket).not.toHaveBeenCalled();
  });

  it("surfaces a clear error and rolls back when there is no live connection to send over", async () => {
    const fake = installFakeSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagram,
            document: emptyGraphDocument,
            revision: 0,
          }),
        ),
      ),
    );
    const store = useDiagramDocumentStore();
    await store.load("d-1");
    store.disconnect();
    fake.sent.length = 0;

    const result = await store.moveNode("a", { x: 1, y: 1 });
    expect(result).toBeUndefined();
    expect(store.error).toBe(
      "Not connected. Check your connection and try again.",
    );
    expect(fake.sent).toHaveLength(0);
  });

  it("times out an operation that never receives a response and rolls back", async () => {
    vi.useFakeTimers();
    const withNode = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "a",
          type: "actor" as const,
          position: { x: 0, y: 0 },
          data: { kind: "external-actor" as const, label: "A" },
        },
      ],
    };
    const { store } = await loadWithFakeSocket({
      document: withNode,
      revision: 1,
    });

    const pending = store.moveNode("a", { x: 9, y: 9 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toBeUndefined();
    expect(store.error).toBe(
      "Could not reach the server. Check your connection and try again.",
    );
    expect(store.document).toEqual(withNode);
    expect(store.pending).toBe(false);
  });

  it("updates remoteCursors from a cursor frame and clears it on participant_left", async () => {
    const { store, fake } = await loadWithFakeSocket();
    fake.callbacks.onFrame({
      type: "cursor",
      email: "editor@example.com",
      role: "editor",
      x: 10,
      y: 20,
      selection: null,
    } satisfies ServerFrame);
    expect(store.remoteCursorList).toEqual([
      {
        email: "editor@example.com",
        role: "editor",
        x: 10,
        y: 20,
        selection: null,
      },
    ]);

    fake.callbacks.onFrame({
      type: "participant_left",
      participant: { email: "editor@example.com", role: "editor" },
      participants: [],
    } satisfies ServerFrame);
    expect(store.remoteCursorList).toEqual([]);
    expect(store.participants).toEqual([]);
  });

  it("updates participants from participant_joined", async () => {
    const { store, fake } = await loadWithFakeSocket();
    fake.callbacks.onFrame({
      type: "participant_joined",
      participant: { email: "editor@example.com", role: "editor" },
      participants: [
        { email: "owner@example.com", role: "owner" },
        { email: "editor@example.com", role: "editor" },
      ],
    } satisfies ServerFrame);
    expect(store.participants).toEqual([
      { email: "owner@example.com", role: "owner" },
      { email: "editor@example.com", role: "editor" },
    ]);
  });

  it("sends a cursor frame over the live connection", async () => {
    const { store, fake } = await loadWithFakeSocket();
    store.sendCursor(3, 4, { kind: "node", id: "a" });
    expect(fake.sent).toEqual([
      { type: "cursor", x: 3, y: 4, selection: { kind: "node", id: "a" } },
    ]);
  });

  it("disconnect() closes the socket and resets connectionStatus to idle", async () => {
    const { store, fake } = await loadWithFakeSocket();
    store.disconnect();
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(store.connectionStatus).toBe("idle");
  });

  it("forwards a job_progress frame to the architecture proposal store", async () => {
    const { fake } = await loadWithFakeSocket();
    const proposalStore = useArchitectureProposalStore();
    proposalStore.job = {
      id: "job-1",
      diagramId: "d-1",
      baseRevision: 1,
      requesterEmail: "owner@example.com",
      status: "generating",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    fake.callbacks.onFrame({
      type: "job_progress",
      jobId: "job-1",
      status: "validating",
      updatedAt: "2026-01-01T00:01:00.000Z",
    } satisfies ServerFrame);

    expect(proposalStore.job?.status).toBe("validating");
  });

  it("tells the architecture proposal store when the socket connects/disconnects", async () => {
    const { store, fake } = await loadWithFakeSocket();
    const proposalStore = useArchitectureProposalStore();
    proposalStore.setSocketConnected = vi.fn();

    fake.callbacks.onStatusChange("connected");
    expect(proposalStore.setSocketConnected).toHaveBeenCalledWith(true);

    store.disconnect();
    expect(proposalStore.setSocketConnected).toHaveBeenCalledWith(false);
  });
});
