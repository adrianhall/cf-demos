import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { mockGetDiagram } = vi.hoisted(() => ({ mockGetDiagram: vi.fn() }));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  addCollaborator: vi.fn(),
  diagramLiveUrl: (id: string) => `ws://localhost/api/diagrams/${encodeURIComponent(id)}/live`,
  // The editor loads through `getAccessibleDiagram`, which returns the diagram *and* the caller's
  // role. The double keeps `mockGetDiagram` as the diagram source so these tests continue to say
  // what they are about — which diagram the shell asked for — and supplies the owner role every
  // assertion here assumes. The role's own effects are covered in `./Toolbar.test.tsx`.
  getAccessibleDiagram: async (id: string) => ({
    diagram: (await mockGetDiagram(id)) as unknown,
    role: 'owner' as const
  }),
  listCollaborators: vi.fn(async () => []),
  removeCollaborator: vi.fn(),
  saveDiagramGraph: vi.fn(),
  updateDiagram: vi.fn()
}));

const { installFakeWebSocket } = await import('./fake-websocket.ts');
const { EditorView } = await import('../../src/client/views/EditorView.tsx');
const { AppShellView } = await import('../../src/client/views/AppShellView.tsx');

/**
 * @file Covers the editor's place in the application: that the shell routes a diagram path to it
 *   with the right id, and that it is mounted inside the React Flow provider its toolbar and status
 *   bar read from.
 */

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * Points `window.location.pathname` at a path. Jsdom's `location` is read-only, so it is replaced
 * wholesale rather than mutated.
 *
 * @param pathname Path the shell should resolve.
 */
function visit(pathname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname },
    writable: true
  });
}

beforeEach(() => {
  localStorage.clear();
  // The editor canvas opens a live-sync socket on mount, and jsdom has no WebSocket at all.
  installFakeWebSocket();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  );
  mockGetDiagram.mockReset().mockResolvedValue({
    description: '',
    graphData: JSON.stringify({ edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
    id: 'abc',
    ownerEmail: 'alice@example.com',
    title: 'My Diagram'
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('EditorView', () => {
  it('renders the canvas for the diagram it was given', async () => {
    render(<EditorView diagramId="abc" />);

    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    expect(mockGetDiagram).toHaveBeenCalledWith('abc');
  });

  // The provider lives in this view rather than inside the canvas so the toolbar and status bar
  // share one instance: nested deeper, the toolbar's zoom controls would be addressing a
  // different canvas than the one on screen.
  it('provides one React Flow context for the canvas and its toolbar together', async () => {
    render(<EditorView diagramId="abc" />);

    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Fit view' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('reaching the editor from the shell', () => {
  it('opens the diagram named in the path', async () => {
    visit('/app/diagram/abc');
    render(<AppShellView />);

    await waitFor(() => expect(mockGetDiagram).toHaveBeenCalledWith('abc'));
    expect(screen.getByLabelText('Diagram title')).toHaveValue('My Diagram');
  });

  // The editor's toolbar sits where the header would, and its back control already reaches a page
  // that has the header and its sign-out control — so both would be two banners, the upper one
  // offering nothing.
  it('replaces the common header with the editor\u2019s own toolbar', async () => {
    visit('/app/diagram/abc');
    render(<AppShellView />);

    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/app');
  });
});
