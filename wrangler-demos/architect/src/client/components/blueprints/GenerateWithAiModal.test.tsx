import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockCreateDiagram, mockSaveDiagramGraph, mockDeleteDiagram } =
  vi.hoisted(() => ({
    mockCreateDiagram: vi.fn(),
    mockDeleteDiagram: vi.fn(),
    mockSaveDiagramGraph: vi.fn(),
  }));
vi.mock("../../api/diagrams", () => ({
  createDiagram: mockCreateDiagram,
  deleteDiagram: mockDeleteDiagram,
  saveDiagramGraph: mockSaveDiagramGraph,
}));

const { mockComputeAutoLayout } = vi.hoisted(() => ({
  mockComputeAutoLayout: vi.fn(),
}));
vi.mock("../../lib/auto-layout", () => ({
  computeAutoLayout: mockComputeAutoLayout,
}));

const { useDiagramStore } = await import("../../stores/diagramStore");
const { GenerateWithAiModal } = await import("./GenerateWithAiModal");

/**
 * A deterministic WebSocket test double, mirroring `../../hooks/useDiagramLiveSync.test.ts`'s
 * own `MockWebSocket` exactly (real browser WebSockets connect asynchronously and cannot be
 * driven from a unit test) -- this test drives the **real** `useDiagramLiveSync()` hook through
 * this component, rather than mocking that hook away, so this suite exercises the actual wiring
 * `GenerateWithAiModal.tsx` performs end to end.
 */
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  closed = false;
  readyState = MockWebSocket.CONNECTING;
  sentMessages: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  /** Test helper: simulate the socket finishing its connection handshake. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Test helper: simulate a server-sent frame. */
  simulateMessage(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
  }
}

/** @returns The most recently constructed mock socket. */
function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("Expected a WebSocket to have been constructed.");
  }
  return socket;
}

/** Type-narrow one sent frame back out of a `MockWebSocket`'s recorded `sentMessages`. */
function parseSent(
  socket: MockWebSocket,
  index: number,
): Record<string, unknown> {
  const raw = socket.sentMessages[index];
  if (raw === undefined) {
    throw new Error(`Expected at least ${index + 1} sent message(s).`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

const EXPECTED_PROMPT =
  "The user wants: A real-time strategy game backend. Propose an initial Cloudflare " +
  "architecture using only the available product types, with sensible connections between " +
  "them. Call rename_diagram with a short, descriptive title. Briefly explain your choices " +
  "when you are done.";

describe("GenerateWithAiModal", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    mockCreateDiagram.mockReset();
    mockSaveDiagramGraph.mockReset();
    mockDeleteDiagram.mockReset();
    mockComputeAutoLayout.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      // A real, absolute `href` -- unlike `../../components/blueprints/CreateDiagramModal.test.tsx`'s
      // own `href: ""`, this component's `useDiagramLiveSync()` call needs a valid base URL to
      // resolve the WebSocket's relative `/api/diagrams/:id/live` path against
      // (`../../hooks/useDiagramLiveSync.ts`'s `liveSyncUrl()`).
      value: { ...originalLocation, href: "http://localhost/blueprints" },
    });
    useDiagramStore.setState({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-01-01T00:00:00.000Z",
      liveUpdateNotice: null,
      pendingOperations: new Map(),
      dirty: false,
      undoStack: [],
      redoStack: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <GenerateWithAiModal open={false} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the description textarea and a disabled Generate button when empty", () => {
    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    expect(
      screen.getByLabelText("Describe the architecture you want to build"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("does not call createDiagram just from being opened", () => {
    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    expect(mockCreateDiagram).not.toHaveBeenCalled();
  });

  it("creates a diagram, opens a socket, and sends the synthesized prompt once connected", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });

    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A real-time strategy game backend" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(mockCreateDiagram).toHaveBeenCalledWith({}));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(latestSocket().url).toContain("/api/diagrams/diagram-123/live");

    // No message sent yet -- the socket has not reported open.
    expect(latestSocket().sentMessages).toHaveLength(0);

    act(() => latestSocket().simulateOpen());

    await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(1));
    const sent = parseSent(latestSocket(), 0);
    expect(sent).toMatchObject({
      text: EXPECTED_PROMPT,
      type: "chat_message",
    });

    // The UI has switched from the textarea view to the transcript view.
    expect(
      screen.queryByLabelText("Describe the architecture you want to build"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();
  });

  it("shows a visible error, without opening a socket, when createDiagram fails", async () => {
    mockCreateDiagram.mockRejectedValue(
      new Error("Could not reach the server."),
    );

    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not reach the server.",
      ),
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    // Still on the textarea view, and the button is usable again.
    expect(
      screen.getByLabelText("Describe the architecture you want to build"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled();
  });

  it("shows a generic message when the creation failure is not an Error instance", async () => {
    mockCreateDiagram.mockRejectedValue("boom");

    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not create the diagram.",
      ),
    );
  });

  it("renders operation_applied/chat_done-driven transcript entries as they arrive", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });

    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().simulateOpen());
    await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(1));
    const { clientRequestId } = parseSent(latestSocket(), 0) as {
      clientRequestId: string;
    };

    act(() =>
      latestSocket().simulateMessage({
        type: "chat_status",
        clientRequestId,
        message: "Checking Cloudflare docs…",
      }),
    );
    act(() =>
      latestSocket().simulateMessage({
        type: "operation_applied",
        actorEmail: "owner@example.com",
        op: {
          input: {
            label: "Workers",
            position: { x: 0, y: 0 },
            typeId: "worker",
          },
          kind: "add_node",
        },
        origin: "ai-chat",
        sequence: 1,
      }),
    );
    act(() =>
      latestSocket().simulateMessage({
        type: "chat_done",
        clientRequestId,
        assistantText: "Added a Worker to get started.",
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("Checking Cloudflare docs…")).toBeInTheDocument(),
    );
    expect(screen.getByText("Added node: Workers")).toBeInTheDocument();
    expect(
      screen.getByText("Added a Worker to get started."),
    ).toBeInTheDocument();
  });

  it("sends a follow-up refinement turn from the transcript view's own composer", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });

    render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().simulateOpen());
    await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(1));
    const { clientRequestId } = parseSent(latestSocket(), 0) as {
      clientRequestId: string;
    };
    act(() =>
      latestSocket().simulateMessage({
        type: "chat_done",
        clientRequestId,
        assistantText: "Here is an initial layout.",
      }),
    );

    const textarea = screen.getByLabelText("Message the AI assistant");
    fireEvent.change(textarea, {
      target: { value: "Use Durable Objects instead of KV." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // Sent on the very same socket -- no second connection opened for the follow-up.
    expect(MockWebSocket.instances).toHaveLength(1);
    await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(2));
    expect(parseSent(latestSocket(), 1)).toMatchObject({
      text: "Use Durable Objects instead of KV.",
      type: "chat_message",
    });
  });

  it("closes without any delete/rollback call when abandoned before the first message is sent", () => {
    const onClose = vi.fn();
    render(<GenerateWithAiModal open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCreateDiagram).not.toHaveBeenCalled();
    expect(mockDeleteDiagram).not.toHaveBeenCalled();
  });

  it("closes without any delete/rollback call when abandoned after a turn has run", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });
    const onClose = vi.fn();

    render(<GenerateWithAiModal open onClose={onClose} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().simulateOpen());
    await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(1));
    const { clientRequestId } = parseSent(latestSocket(), 0) as {
      clientRequestId: string;
    };
    act(() =>
      latestSocket().simulateMessage({
        type: "chat_done",
        clientRequestId,
        assistantText: "Done.",
      }),
    );

    // Disambiguated from the dialog's own "×" close button, which shares the accessible name
    // "Close" -- this is the footer's own dedicated dismiss control for the chat view.
    const footer = document.querySelector(".create-diagram-modal__actions");
    fireEvent.click(
      within(footer as HTMLElement).getByRole("button", { name: "Close" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    // The diagram row created in step 1 is deliberately left behind -- no cleanup call at all.
    expect(mockDeleteDiagram).not.toHaveBeenCalled();
  });

  describe("Open in Editor", () => {
    /** Drive the modal through diagram creation, connection, and one completed turn, returning
     * the resulting `clientRequestId` in case a test needs to simulate more frames. */
    async function completeFirstTurn(): Promise<void> {
      mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });
      fireEvent.change(
        screen.getByLabelText("Describe the architecture you want to build"),
        { target: { value: "A game backend." } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().simulateOpen());
      await waitFor(() => expect(latestSocket().sentMessages).toHaveLength(1));
      const { clientRequestId } = parseSent(latestSocket(), 0) as {
        clientRequestId: string;
      };
      act(() =>
        latestSocket().simulateMessage({
          type: "chat_done",
          clientRequestId,
          assistantText: "Done.",
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Open in Editor" }),
        ).not.toBeDisabled(),
      );
    }

    it("is disabled until the first turn completes", async () => {
      mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });
      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      fireEvent.change(
        screen.getByLabelText("Describe the architecture you want to build"),
        { target: { value: "A game backend." } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().simulateOpen());

      expect(
        screen.getByRole("button", { name: "Open in Editor" }),
      ).toBeDisabled();
    });

    it("runs auto-layout and saves the result when the conversation added nodes", async () => {
      mockComputeAutoLayout.mockResolvedValue({
        edges: [{ id: "e1", source: "n1", target: "n2" }],
        nodes: [
          {
            data: { label: "Workers", typeId: "worker" },
            id: "n1",
            position: { x: 10, y: 20 },
          },
        ],
      });

      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      await completeFirstTurn();

      act(() =>
        latestSocket().simulateMessage({
          type: "operation_applied",
          actorEmail: "owner@example.com",
          op: {
            input: {
              label: "Workers",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            kind: "add_node",
          },
          origin: "ai-chat",
          sequence: 1,
        }),
      );
      expect(useDiagramStore.getState().nodes).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));

      await waitFor(() =>
        expect(mockComputeAutoLayout).toHaveBeenCalledWith(
          useDiagramStore.getState().nodes,
          useDiagramStore.getState().edges,
          "DOWN",
        ),
      );
      await waitFor(() =>
        expect(mockSaveDiagramGraph).toHaveBeenCalledWith(
          "diagram-123",
          expect.stringContaining('"n1"'),
        ),
      );
      await waitFor(() =>
        expect(window.location.href).toBe("/app/diagram/diagram-123"),
      );
    });

    it("does not run auto-layout or save when no nodes were ever added, but still navigates", async () => {
      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      await completeFirstTurn();

      expect(useDiagramStore.getState().nodes).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));

      await waitFor(() =>
        expect(window.location.href).toBe("/app/diagram/diagram-123"),
      );
      expect(mockComputeAutoLayout).not.toHaveBeenCalled();
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });

    it("skips the save call when computeAutoLayout reports nothing to apply", async () => {
      mockComputeAutoLayout.mockResolvedValue(null);

      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      await completeFirstTurn();

      act(() =>
        latestSocket().simulateMessage({
          type: "operation_applied",
          actorEmail: "owner@example.com",
          op: {
            input: {
              label: "Workers",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            kind: "add_node",
          },
          origin: "ai-chat",
          sequence: 1,
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));

      await waitFor(() => expect(mockComputeAutoLayout).toHaveBeenCalled());
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(window.location.href).toBe("/app/diagram/diagram-123"),
      );
    });

    it("shows a visible error and re-enables the button when the save fails", async () => {
      mockComputeAutoLayout.mockResolvedValue({
        edges: [],
        nodes: [
          {
            data: { label: "Workers", typeId: "worker" },
            id: "n1",
            position: { x: 10, y: 20 },
          },
        ],
      });
      mockSaveDiagramGraph.mockRejectedValue(new Error("Save failed."));

      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      await completeFirstTurn();

      act(() =>
        latestSocket().simulateMessage({
          type: "operation_applied",
          actorEmail: "owner@example.com",
          op: {
            input: {
              label: "Workers",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            kind: "add_node",
          },
          origin: "ai-chat",
          sequence: 1,
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Save failed."),
      );
      // Navigation never happened -- the error left the operator on this view to retry.
      expect(window.location.href).toBe("http://localhost/blueprints");
      expect(
        screen.getByRole("button", { name: "Open in Editor" }),
      ).not.toBeDisabled();
    });

    it("shows a generic error when the save failure is not an Error instance", async () => {
      mockComputeAutoLayout.mockResolvedValue({
        edges: [],
        nodes: [
          {
            data: { label: "Workers", typeId: "worker" },
            id: "n1",
            position: { x: 10, y: 20 },
          },
        ],
      });
      mockSaveDiagramGraph.mockRejectedValue("boom");

      render(<GenerateWithAiModal open onClose={vi.fn()} />);
      await completeFirstTurn();

      act(() =>
        latestSocket().simulateMessage({
          type: "operation_applied",
          actorEmail: "owner@example.com",
          op: {
            input: {
              label: "Workers",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            kind: "add_node",
          },
          origin: "ai-chat",
          sequence: 1,
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Could not open the diagram in the editor.",
        ),
      );
    });
  });

  it("closes and reopens the socket in step with the modal's own open prop", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "diagram-123" });
    const { rerender } = render(<GenerateWithAiModal open onClose={vi.fn()} />);
    fireEvent.change(
      screen.getByLabelText("Describe the architecture you want to build"),
      { target: { value: "A game backend." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const firstSocket = latestSocket();
    act(() => firstSocket.simulateOpen());

    rerender(<GenerateWithAiModal open={false} onClose={vi.fn()} />);
    expect(firstSocket.closed).toBe(true);

    rerender(<GenerateWithAiModal open onClose={vi.fn()} />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  });
});
