import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { ConnectNodesModal } =
  await import('../../src/client/components/editor/toolbar/ConnectNodesModal.tsx');

/**
 * @file Covers the connection dialog. It exists because React Flow's own way of creating an edge is
 *   a pointer drag between two unfocusable handles, so these tests deliberately never simulate a
 *   drag: every one of them works the dialog the way a keyboard user would, through native form
 *   controls and a button.
 */

beforeEach(() => {
  useDiagramStore.setState({
    diagramId: 'd1',
    dirty: false,
    edges: [],
    nodes: [
      {
        data: { label: 'API Worker', typeId: 'worker' },
        id: 'a',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      },
      {
        data: { label: 'Primary DB', typeId: 'd1' },
        id: 'b',
        position: { x: 300, y: 0 },
        type: 'cf-node'
      },
      {
        data: { label: 'Cache', typeId: 'kv' },
        id: 'c',
        position: { x: 0, y: 300 },
        type: 'cf-node'
      }
    ],
    propertiesOpen: false,
    redoStack: [],
    selectedEdgeId: null,
    selectedNodeId: null,
    undoStack: []
  });
});

describe('choosing what to connect', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ConnectNodesModal open={false} onClose={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  // Two nodes regularly carry the same label, so the product qualifies each option — without it
  // a diagram with two workers both called "API" would offer an unresolvable choice.
  it('qualifies every node by its product', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    const source = screen.getByLabelText('Source');

    expect(
      within(source)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['API Worker (Workers)', 'Primary DB (D1 Database)', 'Cache (Workers KV)']);
  });

  it('falls back to the stored type for a product the catalogue no longer defines', () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: 'Legacy', typeId: 'no-longer-a-product' },
          id: 'a',
          position: { x: 0, y: 0 },
          type: 'cf-node'
        },
        {
          data: { label: 'Primary DB', typeId: 'd1' },
          id: 'b',
          position: { x: 300, y: 0 },
          type: 'cf-node'
        }
      ]
    });
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(
      screen.getAllByRole('option', { name: 'Legacy (no-longer-a-product)' }).length
    ).toBeGreaterThan(0);
  });

  // A visitor who selected a node and then opened this dialog has already said what they want to
  // connect from.
  it('starts from the selected node, paired with another', () => {
    useDiagramStore.setState({ selectedNodeId: 'b' });
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByLabelText('Source')).toHaveValue('b');
    expect(screen.getByLabelText('Target')).toHaveValue('a');
  });

  it('starts from the first node when nothing is selected', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByLabelText('Source')).toHaveValue('a');
    expect(screen.getByLabelText('Target')).toHaveValue('b');
  });
});

describe('refusing an impossible connection', () => {
  // Shown while the visitor is still choosing rather than after they commit, and announced,
  // because a disabled button with no stated reason is indistinguishable from a broken one.
  it('explains a self-connection and disables the action', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'a' } });

    expect(screen.getByRole('alert')).toHaveTextContent('A node cannot be connected to itself.');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('explains an exact duplicate', () => {
    useDiagramStore.setState({
      edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'a', target: 'b' }]
    });
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'These nodes are already connected with that edge type.'
    );
  });

  it('allows the same pair again once a different type is chosen', () => {
    useDiagramStore.setState({
      edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'a', target: 'b' }]
    });
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Connection type'), { target: { value: 'trigger' } });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });
});

describe('making the connection', () => {
  it('creates the chosen edge and closes', () => {
    const onClose = vi.fn();
    render(<ConnectNodesModal open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'c' } });
    fireEvent.change(screen.getByLabelText('Connection type'), { target: { value: 'trigger' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(useDiagramStore.getState().edges[0]).toMatchObject({
      data: { edgeType: 'trigger' },
      source: 'a',
      target: 'c'
    });
    expect(onClose).toHaveBeenCalled();
  });

  // The new edge is selected, which opens the details panel on it — so the visitor lands on the
  // fields for what they just made rather than having to find it on the canvas.
  it('leaves the new edge selected', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(useDiagramStore.getState().selectedEdgeId).not.toBeNull();
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });
});

describe('dismissing the dialog', () => {
  // Four affordances sharing one handler, asserted separately: a regression that broke only the
  // keyboard path would otherwise pass.
  it.each([
    ['Cancel', (): void => void fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    [
      'the close control',
      (): void => void fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    ],
    [
      'the backdrop',
      (): void => void fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    ],
    ['Escape', (): void => void fireEvent.keyDown(document, { key: 'Escape' })]
  ])('closes without changing the diagram via %s', (_description, dismiss) => {
    const onClose = vi.fn();
    render(<ConnectNodesModal open onClose={onClose} />);

    dismiss();

    expect(onClose).toHaveBeenCalled();
    expect(useDiagramStore.getState().edges).toHaveLength(0);
  });
});

describe('focus management', () => {
  it('moves focus into the dialog on open', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  // The backdrop is a real button so it can be clicked, but it must not be a tab stop: it is
  // invisible and has no affordance, so landing on it from the keyboard would be a dead end.
  it('keeps the backdrop out of the tab order', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveAttribute('tabindex', '-1');
  });

  it('claims to be modal, which is what the focus trap makes true', () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});
