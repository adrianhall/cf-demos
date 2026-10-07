import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { mockGetSharedDiagram } = vi.hoisted(() => ({ mockGetSharedDiagram: vi.fn() }));
vi.mock('../../src/client/api/shares.ts', () => ({
  createShare: vi.fn(),
  getSharedDiagram: mockGetSharedDiagram,
  getShareStatus: vi.fn(),
  revokeShare: vi.fn()
}));

const { mockGetDiagram } = vi.hoisted(() => ({ mockGetDiagram: vi.fn() }));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  getDiagram: mockGetDiagram,
  saveDiagramGraph: vi.fn(),
  updateDiagram: vi.fn()
}));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { ShareView } = await import('../../src/client/views/ShareView.tsx');

/**
 * @file Covers the anonymous share viewer. The assertion that matters most is a negative one: this
 *   page must never touch the owner-authenticated diagram API, which would answer `401` for exactly
 *   the visitor it exists to serve. The rest is the posture — a landmark to skip to, a read-only
 *   canvas, and a refusal that uses the server's deliberately uniform wording.
 */

/**
 * An empty but well-formed stored graph.
 */
const EMPTY_GRAPH = JSON.stringify({ edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } });

/**
 * The resolver's response for a shared diagram.
 */
const SHARED = {
  description: 'Public notes',
  graphData: EMPTY_GRAPH,
  id: 'shared-1',
  title: 'Shared Diagram'
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  useDiagramStore.setState({
    description: '',
    diagramId: null,
    dirty: false,
    edges: [],
    nodes: [],
    paletteOpen: true,
    propertiesOpen: true,
    redoStack: [],
    title: 'Untitled Diagram',
    undoStack: []
  });
  mockGetSharedDiagram.mockReset().mockResolvedValue(SHARED);
  mockGetDiagram.mockReset();
  mockXyflow.mockFitView.mockClear();
});

/**
 * Renders the viewer and waits for the canvas to appear.
 *
 * @param token Token to render for.
 * @returns The render result.
 */
async function renderResolved(token = 't'.repeat(43)) {
  const view = render(<ShareView token={token} />);
  await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
  return view;
}

describe('loading', () => {
  it('waits rather than showing an empty canvas', () => {
    mockGetSharedDiagram.mockReturnValue(new Promise(() => {}));
    render(<ShareView token="tok" />);

    expect(screen.getByText('Loading shared diagram…')).toBeInTheDocument();
    expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
  });

  it('resolves the token it was given', async () => {
    await renderResolved('abc123');

    expect(mockGetSharedDiagram).toHaveBeenCalledWith('abc123');
  });

  // The whole reason this page has its own API module path: an anonymous visitor has no Access
  // identity, so the owner-authenticated read would answer `401` for a page they are entitled
  // to see.
  it('never calls the owner-authenticated diagram API', async () => {
    await renderResolved();

    expect(mockGetDiagram).not.toHaveBeenCalled();
  });

  it('ignores a resolution that arrives after the visitor has navigated away', async () => {
    let resolveShare!: (value: typeof SHARED) => void;
    mockGetSharedDiagram.mockReturnValue(
      new Promise((resolve) => {
        resolveShare = resolve;
      })
    );
    const { unmount } = render(<ShareView token="tok" />);

    unmount();
    resolveShare(SHARED);
    await Promise.resolve();
  });

  it('ignores a refusal that arrives after the visitor has navigated away', async () => {
    let rejectShare!: (reason: unknown) => void;
    mockGetSharedDiagram.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectShare = reject;
      })
    );
    const { unmount } = render(<ShareView token="tok" />);

    unmount();
    rejectShare(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('the resolved viewer', () => {
  it('renders the shared diagram and says it is read-only', async () => {
    await renderResolved();

    expect(screen.getByText('You’re viewing a shared diagram, read-only.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Shared Diagram');
  });

  // Every other top-level view has a landmark; without one here an anonymous visitor using a
  // screen reader has nothing to skip to.
  it('gives the page a main landmark', async () => {
    await renderResolved();

    expect(screen.getByRole('main')).toHaveClass('share-view');
  });

  it('offers a way into the application for a visitor who wants their own diagram', async () => {
    await renderResolved();

    expect(screen.getByRole('link', { name: /create your own diagram/iu })).toHaveAttribute(
      'href',
      '/app'
    );
  });

  // The token is a bearer credential. Rendering it would put it into any screenshot of this page
  // and into any bug report attached to one, for no benefit — the visitor already has the link in
  // their address bar.
  it('never renders the token anywhere in the document', async () => {
    const token = 'q'.repeat(43);
    const { container } = await renderResolved(token);

    expect(container.innerHTML).not.toContain(token);
  });
});

describe('the read-only posture', () => {
  // Omitted rather than disabled: each would be a tab stop leading to a refusal.
  it.each(['Toggle service palette', 'Connect nodes', 'Undo', 'Zoom in', 'Share diagram'])(
    'omits %s',
    async (name) => {
      await renderResolved();

      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  );

  it('shows the title as plain text rather than an editable field', async () => {
    await renderResolved();

    expect(screen.queryByLabelText('Diagram title')).not.toBeInTheDocument();
    expect(screen.getByText('Shared Diagram')).toBeInTheDocument();
  });

  it('withholds the palette and the details panel entirely', async () => {
    await renderResolved();

    expect(screen.queryByRole('heading', { name: 'Services' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
  });

  it('tells the visitor the canvas is read-only rather than reporting a save state', async () => {
    await renderResolved();

    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  // Asserted on the props React Flow receives, because jsdom cannot perform a drag: with these
  // false, the library itself stops offering the interaction.
  it('disables node dragging and connecting on the canvas itself', async () => {
    await renderResolved();

    const canvas = screen.getByTestId('react-flow');

    expect(canvas).toHaveAttribute('data-nodes-draggable', 'false');
    expect(canvas).toHaveAttribute('data-nodes-connectable', 'false');
  });

  // A visitor reading somebody else's diagram has the same reason to want dark mode as its owner.
  it('keeps the appearance control', async () => {
    await renderResolved();

    expect(screen.getByRole('button', { name: /appearance/iu })).toBeInTheDocument();
  });
});

describe('a link that does not resolve', () => {
  it('reports the server\u2019s uniform refusal and offers a way out', async () => {
    mockGetSharedDiagram.mockRejectedValue(new Error('Share link not found or revoked.'));
    render(<ShareView token="missing" />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Share link not found or revoked.')
    );
    expect(screen.getByRole('link', { name: 'Go to Architect' })).toHaveAttribute('href', '/');
  });

  // The server reports a malformed, unknown, revoked and deleted link identically on purpose, so
  // this page must not invent wording that distinguishes them.
  it('falls back to the same wording when the failure carried no message', async () => {
    mockGetSharedDiagram.mockRejectedValue('boom');
    render(<ShareView token="missing" />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Share link not found or revoked.')
    );
  });

  it('still gives the refusal page a landmark', async () => {
    mockGetSharedDiagram.mockRejectedValue(new Error('Share link not found or revoked.'));
    render(<ShareView token="missing" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders no canvas for a link that did not resolve', async () => {
    mockGetSharedDiagram.mockRejectedValue(new Error('Share link not found or revoked.'));
    render(<ShareView token="missing" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
  });
});
