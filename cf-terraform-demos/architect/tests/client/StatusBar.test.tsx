import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { StatusBar } = await import('../../src/client/components/editor/toolbar/StatusBar.tsx');

/**
 * @file Covers the status bar. Autosave is silent by design, so this is the only place that says
 *   whether a visitor's work is safe — which makes the precedence between its states the thing
 *   worth pinning: a failed save must not be reported as merely unsaved, and a read-only canvas
 *   must not be reported as having unsaved changes at all.
 */

beforeEach(() => {
  useDiagramStore.setState({
    dirty: false,
    edges: [],
    lastSavedAt: null,
    nodes: [],
    saveError: null,
    saving: false
  });
  mockXyflow.mockGetZoom.mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the save state', () => {
  it('reports no changes before anything has happened', () => {
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText('No changes')).toBeInTheDocument();
  });

  it('reports unsaved changes while a change is pending', () => {
    useDiagramStore.setState({ dirty: true });
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('reports a save in flight', () => {
    useDiagramStore.setState({ dirty: true, saving: true });
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  // Ranked above the dirty flag deliberately: a failed save leaves the diagram dirty too, and
  // reporting that as "unsaved changes" would describe a failure as though it were merely pending.
  it('reports a failure in preference to the unsaved state it leaves behind', () => {
    useDiagramStore.setState({ dirty: true, saveError: 'Network error' });
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText('Error: Network error')).toBeInTheDocument();
  });

  // Outranks everything: a viewer with nothing to save should never be told their changes are
  // unsaved.
  it('reports read-only whatever the store says', () => {
    useDiagramStore.setState({ dirty: true, saveError: 'Network error' });
    render(<StatusBar readOnly />);

    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it.each([
    ['just now', 0, 'Saved just now'],
    ['in seconds', 30_000, 'Saved 30s ago'],
    ['in minutes', 125_000, 'Saved 2m ago']
  ])('reports a completed save %s', (_description, age, expected) => {
    useDiagramStore.setState({ lastSavedAt: Date.now() - age });
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('the diagram size', () => {
  it.each([
    ['none of either', 0, 0, '0 nodes, 0 edges'],
    ['exactly one of each', 1, 1, '1 node, 1 edge'],
    ['several of each', 2, 3, '2 nodes, 3 edges']
  ])('counts %s', (_description, nodeCount, edgeCount, expected) => {
    useDiagramStore.setState({
      edges: Array.from({ length: edgeCount }, (_value, index) => ({
        data: { edgeType: 'data-flow' as const },
        id: `e${index}`,
        source: 'a',
        target: 'b'
      })),
      nodes: Array.from({ length: nodeCount }, (_value, index) => ({
        data: { label: 'W', typeId: 'worker' },
        id: `n${index}`,
        position: { x: 0, y: 0 }
      }))
    });
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('the zoom reading', () => {
  // Polled rather than subscribed: zoom changes continuously during a pinch, and re-rendering the
  // bar on every frame would cost more than a reading nobody watches closely is worth.
  it('refreshes once a second', () => {
    vi.useFakeTimers();
    render(<StatusBar readOnly={false} />);

    expect(screen.getByText('Zoom: 100%')).toBeInTheDocument();

    mockXyflow.mockGetZoom.mockReturnValue(1.5);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText('Zoom: 150%')).toBeInTheDocument();
  });
});

describe('announcing changes', () => {
  // `role="status"` so a change is announced without taking focus away from the canvas the
  // visitor is working on.
  it('is a polite live region', () => {
    render(<StatusBar readOnly={false} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
