import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { mockCreateDiagram, mockSaveDiagramGraph } = vi.hoisted(() => ({
  mockCreateDiagram: vi.fn(),
  mockSaveDiagramGraph: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  createDiagram: mockCreateDiagram,
  // The real builder rather than a stub: it is pure, and the URL is the thing that proves this
  // modal reaches the same route the editor does rather than one of its own.
  diagramLiveUrl: (id: string) => `ws://localhost/api/diagrams/${encodeURIComponent(id)}/live`,
  saveDiagramGraph: mockSaveDiagramGraph
}));

// ELK is a 1.4 MB engine reached through a dynamic import. What matters here is whether the one
// layout pass runs and what it persists, never how well a third-party engine arranges a graph.
const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class MockElk {
    layout = mockElkLayout;
  }
}));

const { installFakeWebSocket, mostRecentSocket, FakeWebSocket } =
  await import('./fake-websocket.ts');
const { GenerateWithAiModal } =
  await import('../../src/client/components/blueprints/GenerateWithAiModal.tsx');

/**
 * @file Covers the generation modal: that it creates an ordinary diagram and talks to it over the
 *   ordinary live route, that a conversation can be refined before the editor is ever opened, and —
 *   the case that exists because of a real data-loss defect — that opening the editor writes
 *   nothing back over the graph the session already persisted, beyond the single explicit layout
 *   pass. The frames themselves are produced by the Durable Object and covered against `workerd` in
 *   `../integration/live-sync.test.ts`; what this file owns is the modal's reaction to them.
 */

/**
 * Id the create call answers with, so a URL assertion names a constant.
 */
const DIAGRAM_ID = 'gen-1';

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

beforeEach(() => {
  installFakeWebSocket();
  mockCreateDiagram.mockReset().mockResolvedValue({ id: DIAGRAM_ID, title: 'Untitled Diagram' });
  mockSaveDiagramGraph.mockReset().mockResolvedValue('2026-02-01T00:00:00.000Z');
  mockElkLayout.mockReset().mockResolvedValue({ children: [] });
  // Replaced wholesale because jsdom's `location` is read-only, and the Open in Editor path
  // asserts on the document navigation the modal performs.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
    writable: true
  });
});

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
  vi.unstubAllGlobals();
});

/**
 * Opens the modal and gets as far as a conversation on an open connection.
 *
 * The handshake is completed explicitly, because the double begins `OPEN` without ever dispatching
 * the event a real socket dispatches. The modal waits for that event rather than reading
 * `readyState`, which is the correct production behaviour: a browser's socket is `CONNECTING` for
 * as long as the upgrade takes, and sending before it opens would silently drop the one message
 * this whole flow exists to send.
 *
 * @param description What the operator types before pressing Generate.
 * @param onClose Close handler, when a test needs to assert on it.
 * @returns The render result.
 */
async function startGenerating(
  description = 'A real-time game backend',
  onClose: () => void = vi.fn()
) {
  const view = render(<GenerateWithAiModal onClose={onClose} />);

  fireEvent.change(screen.getByLabelText(/describe the architecture/iu), {
    target: { value: description }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  await act(async () => {
    mostRecentSocket().simulateOpen();
  });
  return view;
}

/**
 * Reads the `clientRequestId` of the turn the modal most recently started.
 *
 * @param index Which sent frame to read, defaulting to the opening one.
 * @returns The id the modal minted for that turn.
 */
function sentRequestId(index = 0): string {
  const payload = mostRecentSocket().sent[index] as string;
  return (JSON.parse(payload) as { clientRequestId: string }).clientRequestId;
}

/**
 * Delivers one frame and lets React process it.
 *
 * @param frame The frame to deliver.
 * @returns A promise fulfilled once the resulting state change has been applied.
 */
async function deliver(frame: Record<string, unknown>): Promise<void> {
  await act(async () => {
    mostRecentSocket().simulateMessage(frame);
  });
}

/**
 * Builds an `operation_applied` frame attributed to the assistant.
 *
 * @param operation The operation the session confirmed.
 * @param sequence Its position in the stream.
 * @returns The frame.
 */
function aiOperation(operation: Record<string, unknown>, sequence: number) {
  return {
    actor: 'alice@example.com',
    operation,
    operationId: null,
    origin: 'ai-chat',
    sequence,
    type: 'operation_applied',
    updatedAt: `2026-01-0${sequence}T00:00:00.000Z`
  };
}

/**
 * An `add_node` operation for a node with a known id and label.
 *
 * @param id Node id the session assigned.
 * @param label Its display label.
 * @returns The operation.
 */
function addNode(id: string, label: string) {
  return {
    input: { id, label, position: { x: 0, y: 0 }, typeId: 'worker' },
    kind: 'add_node'
  };
}

describe('GenerateWithAiModal', () => {
  it('refuses to generate from an empty description', () => {
    render(<GenerateWithAiModal onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('is a labelled modal dialog', () => {
    render(<GenerateWithAiModal onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Generate with AI' })).toHaveAttribute(
      'aria-modal',
      'true'
    );
  });

  it('closes on Escape, like every other modal', () => {
    const onClose = vi.fn();
    render(<GenerateWithAiModal onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  // Every message shown to the operator is written by this component; a rejection that is not an
  // `Error` has no message worth showing, and showing `[object Object]` would be worse than
  // generic wording.
  it('falls back to its own wording when a creation fails with no message', async () => {
    mockCreateDiagram.mockRejectedValue('nope');
    render(<GenerateWithAiModal onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/describe the architecture/iu), {
      target: { value: 'A game backend' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the diagram.');
  });

  it('reports a failed creation and keeps what was typed', async () => {
    mockCreateDiagram.mockRejectedValue(new Error('Your session has expired.'));
    render(<GenerateWithAiModal onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/describe the architecture/iu), {
      target: { value: 'A game backend' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired.');
    expect(screen.getByLabelText(/describe the architecture/iu)).toHaveValue('A game backend');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  describe('the generation run', () => {
    // No bespoke endpoint: an ordinary blank diagram, then the same live route the editor uses.
    it('creates a blank diagram and connects to its ordinary live route', async () => {
      await startGenerating();

      expect(mockCreateDiagram).toHaveBeenCalledWith({});
      expect(mostRecentSocket().url).toBe(`ws://localhost/api/diagrams/${DIAGRAM_ID}/live`);
    });

    // The scaffolding goes to the model; the transcript shows the sentence the operator typed.
    it('sends a synthesized prompt but shows what the operator wrote', async () => {
      await startGenerating('A real-time game backend');

      const sent = JSON.parse(mostRecentSocket().sent[0] as string) as {
        text: string;
        type: string;
      };
      expect(sent.type).toBe('chat_message');
      expect(sent.text).toContain('A real-time game backend');
      expect(sent.text).toContain('rename_diagram');
      expect(screen.getByText('A real-time game backend')).toBeInTheDocument();
      expect(screen.queryByText(/rename_diagram/u)).not.toBeInTheDocument();
    });

    it('sends the opening message exactly once', async () => {
      await startGenerating();
      await deliver({ clientRequestId: sentRequestId(), text: 'Working…', type: 'chat_token' });

      expect(mostRecentSocket().sent).toHaveLength(1);
    });

    it('narrates each confirmed change and streams the answer', async () => {
      await startGenerating();
      const clientRequestId = sentRequestId();

      await deliver(aiOperation(addNode('api', 'API Worker'), 1));
      await deliver({ clientRequestId, text: 'I added ', type: 'chat_token' });
      await deliver({ clientRequestId, text: 'a Worker.', type: 'chat_token' });
      await deliver({ assistantText: 'I added a Worker.', clientRequestId, type: 'chat_done' });

      expect(screen.getByText('Added node: API Worker')).toBeInTheDocument();
      expect(screen.getByText('I added a Worker.')).toBeInTheDocument();
    });

    // Nothing is sent while the upgrade is still in flight: a frame written to a connecting
    // socket is dropped, and there is no retry affordance in this UI to recover from that.
    it('waits for the connection before sending anything', async () => {
      render(<GenerateWithAiModal onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText(/describe the architecture/iu), {
        target: { value: 'A game backend' }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

      expect(screen.getByText('Connecting…')).toBeInTheDocument();
      expect(mostRecentSocket().sent).toHaveLength(0);

      await act(async () => {
        mostRecentSocket().simulateOpen();
      });

      expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
      expect(mostRecentSocket().sent).toHaveLength(1);
    });

    it('reports the connection dropping', async () => {
      await startGenerating();

      await act(async () => {
        mostRecentSocket().simulateServerClose();
      });

      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    it('ignores a frame it cannot parse', async () => {
      await startGenerating();

      await act(async () => {
        mostRecentSocket().simulateMessage('not json');
      });

      expect(screen.getByText('A real-time game backend')).toBeInTheDocument();
    });

    it('ignores a frame that belongs to a canvas it does not have', async () => {
      await startGenerating();

      await deliver({ color: '#f6821f', email: 'bob@example.com', type: 'presence_joined' });

      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    });

    it('narrates a status frame and a documentation lookup', async () => {
      await startGenerating();
      const clientRequestId = sentRequestId();

      await deliver({ clientRequestId, message: 'Renaming the diagram…', type: 'chat_status' });
      await deliver({
        clientRequestId,
        outcome: {
          ok: true,
          results: [
            {
              snippet: '…',
              title: 'Durable Objects',
              url: 'https://developers.cloudflare.com/durable-objects/'
            }
          ]
        },
        query: 'durable objects',
        tool: 'search_cloudflare_documentation',
        type: 'chat_tool_result'
      });

      expect(screen.getByText('Renaming the diagram…')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /durable objects/iu })).toBeInTheDocument();
    });

    // A human collaborator's edit is somebody else's business: this modal has no canvas to apply
    // it to and no transcript line it belongs on.
    it('does not narrate an operation that was not the assistant’s', async () => {
      await startGenerating();

      await deliver({
        actor: 'bob@example.com',
        operation: addNode('manual', 'Hand-placed'),
        operationId: null,
        origin: 'human',
        sequence: 1,
        type: 'operation_applied',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });

      expect(screen.queryByText(/Added node/u)).not.toBeInTheDocument();
    });

    it('reports a failed turn without closing the conversation', async () => {
      await startGenerating();

      await deliver({
        clientRequestId: sentRequestId(),
        message: 'The assistant is unavailable.',
        type: 'chat_error'
      });

      expect(screen.getByText('The assistant is unavailable.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    });
  });

  describe('refinement', () => {
    it('runs a follow-up turn on the same connection', async () => {
      await startGenerating();
      await deliver({
        assistantText: 'Done.',
        clientRequestId: sentRequestId(),
        type: 'chat_done'
      });

      fireEvent.change(screen.getByLabelText('Message the AI assistant'), {
        target: { value: 'Add a queue' }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      // One socket, two messages: the refinement did not open a second connection, which would
      // have given the model a conversation with no memory of the first turn.
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(mostRecentSocket().sent).toHaveLength(2);
      expect(screen.getByText('Add a queue')).toBeInTheDocument();
    });

    it('refuses a second message while a turn is in flight', async () => {
      await startGenerating();

      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /stop/iu })).toBeInTheDocument();
    });
  });

  describe('opening in the editor', () => {
    /**
     * Runs one turn that adds a node and completes.
     *
     * @param nodeId Id the session assigned the node.
     * @returns A promise fulfilled once the turn's frames have been processed.
     */
    async function runNodeAddingTurn(nodeId = 'api'): Promise<void> {
      const clientRequestId = sentRequestId();
      await deliver(aiOperation(addNode(nodeId, 'API Worker'), 1));
      await deliver({ assistantText: 'Done.', clientRequestId, type: 'chat_done' });
    }

    it('is offered only once a turn has finished', async () => {
      await startGenerating();

      expect(screen.getByRole('button', { name: 'Open in Editor' })).toBeDisabled();

      await runNodeAddingTurn();

      expect(screen.getByRole('button', { name: 'Open in Editor' })).toBeEnabled();
    });

    // The regression this file exists for. Opening the editor used to write the browser's own
    // view of the graph back over the persisted one, destroying the edges the conversation had
    // just created. The only write permitted on this path is the layout pass.
    it('writes nothing but the layout pass over the persisted graph', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      await startGenerating();
      await runNodeAddingTurn();

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));
      await waitFor(() => expect(window.location.href).toBe(`/app/diagram/${DIAGRAM_ID}`));

      expect(mockSaveDiagramGraph).toHaveBeenCalledTimes(1);
      const [, graphData] = mockSaveDiagramGraph.mock.calls[0] as [string, string];
      const saved = JSON.parse(graphData) as { nodes: { id: string; position: unknown }[] };
      // The saved graph is the session's own, repositioned — not a graph this modal composed.
      expect(saved.nodes).toHaveLength(1);
      expect(saved.nodes[0]?.id).toBe('api');
      expect(saved.nodes[0]?.position).toEqual({ x: 48, y: 96 });
    });

    it('skips the layout pass entirely when the conversation added no node', async () => {
      await startGenerating();
      await deliver({
        assistantText: 'Nothing to change.',
        clientRequestId: sentRequestId(),
        type: 'chat_done'
      });

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));
      await waitFor(() => expect(window.location.href).toBe(`/app/diagram/${DIAGRAM_ID}`));

      expect(mockElkLayout).not.toHaveBeenCalled();
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });

    it('navigates without saving when the engine computed nothing', async () => {
      mockElkLayout.mockResolvedValue({});
      await startGenerating();
      await runNodeAddingTurn();

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));
      await waitFor(() => expect(window.location.href).toBe(`/app/diagram/${DIAGRAM_ID}`));

      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });

    it('falls back to its own wording when the save fails with no message', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      mockSaveDiagramGraph.mockRejectedValue('nope');
      await startGenerating();
      await runNodeAddingTurn();

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not open the diagram in the editor.'
      );
    });

    it('reports a failed layout save and stays put', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      mockSaveDiagramGraph.mockRejectedValue(new Error('Could not save the layout.'));
      await startGenerating();
      await runNodeAddingTurn();

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the layout.');
      expect(window.location.href).toBe('');
      expect(screen.getByRole('button', { name: 'Open in Editor' })).toBeEnabled();
    });

    // A snapshot replaces the tracked graph wholesale, exactly as it does on the canvas, so the
    // layout pass operates on what the session actually holds rather than on this tab's replay.
    it('lays out the graph a snapshot replaced', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'from-snapshot', x: 10, y: 20 }] });
      await startGenerating();
      await runNodeAddingTurn();
      await deliver({
        actor: null,
        graphData: JSON.stringify({
          edges: [],
          nodes: [{ data: { label: 'Queue' }, id: 'from-snapshot', position: { x: 0, y: 0 } }],
          viewport: { x: 0, y: 0, zoom: 1 }
        }),
        origin: null,
        sequence: 5,
        type: 'snapshot',
        updatedAt: '2026-03-01T00:00:00.000Z'
      });

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));
      await waitFor(() => expect(mockSaveDiagramGraph).toHaveBeenCalledTimes(1));

      const [, graphData] = mockSaveDiagramGraph.mock.calls[0] as [string, string];
      expect((JSON.parse(graphData) as { nodes: { id: string }[] }).nodes[0]?.id).toBe(
        'from-snapshot'
      );
    });

    // Divergence is the characteristic failure of operation-based sync. Forgetting the tracked
    // graph is the safe response: the layout pass is skipped and the persisted graph is left
    // exactly as the session has it, rather than being overwritten from a stale copy.
    it('abandons its tracked graph rather than laying out a diverged one', async () => {
      await startGenerating();
      await runNodeAddingTurn();
      await deliver(aiOperation({ kind: 'remove_node', nodeId: 'never-existed' }, 2));

      fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }));
      await waitFor(() => expect(window.location.href).toBe(`/app/diagram/${DIAGRAM_ID}`));

      expect(mockElkLayout).not.toHaveBeenCalled();
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });
  });

  describe('abandoning the conversation', () => {
    // Creation is deliberately not transactional with the conversation: the diagram stays,
    // holding whatever was built, exactly as if it had been created blank and edited by hand.
    it('leaves the diagram behind and raises nothing', async () => {
      const onClose = vi.fn();
      await startGenerating('A game backend', onClose);
      await deliver(aiOperation(addNode('api', 'API Worker'), 1));

      // The footer control, not the dialog's own `×` — both are named "Close", and the point of
      // this case is the one the operator reaches for when they have decided to stop.
      const [, footerClose] = screen.getAllByRole('button', { name: 'Close' });
      fireEvent.click(footerClose as HTMLElement);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // No delete, and no write of any kind on the way out.
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });

    // The gallery unmounts this modal rather than hiding it, which is what makes dismissal
    // actually end the conversation instead of leaving a socket open behind a hidden dialog.
    it('closes the connection when it unmounts', async () => {
      const view = await startGenerating();
      const socket = mostRecentSocket();

      view.unmount();

      expect(socket.closedByClient).toBe(true);
      expect(socket.hasMessageListener()).toBe(false);
    });
  });
});
