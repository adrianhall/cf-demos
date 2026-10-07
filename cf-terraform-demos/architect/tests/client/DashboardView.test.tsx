import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { mockListDiagrams } = vi.hoisted(() => ({ mockListDiagrams: vi.fn() }));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  deleteDiagram: vi.fn(),
  duplicateDiagram: vi.fn(),
  listDiagrams: mockListDiagrams
}));

const { AppShellView } = await import('../../src/client/views/AppShellView.tsx');

/**
 * @file Covers the authenticated shell's routing into the dashboard — the end of the creation
 *   journey. The gallery's own suite proves a diagram can be created; this proves the result has
 *   somewhere to arrive.
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
  mockListDiagrams.mockReset().mockResolvedValue([]);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  // The header resolves the identity on mount; the dashboard's own data comes from the mocked API
  // module rather than from `fetch`.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ email: 'alice@example.com', isAdmin: false })))
  );
  visit('/app');
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('the authenticated shell', () => {
  it.each(['/app', '/app/', '/app/unknown'])('renders the dashboard at %s', async (pathname) => {
    visit(pathname);
    render(<AppShellView />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My Diagrams');
    });
  });

  it('lists the diagrams the dashboard loaded', async () => {
    mockListDiagrams.mockResolvedValue([
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        description: null,
        graphData: '{"nodes":[],"edges":[]}',
        id: 'd1',
        ownerEmail: 'alice@example.com',
        title: 'Loaded Diagram',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]);
    render(<AppShellView />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Loaded Diagram' })).toHaveAttribute(
        'href',
        '/app/diagram/d1'
      );
    });
  });

  // The administrative route still reaches its own gate rather than the dashboard, so adding the
  // dashboard did not widen what `/app/admin` renders. The stubbed identity is an ordinary one, so
  // the gate's answer here is its refusal — which is the point: it is the gate answering, not the
  // dashboard rendering.
  it('keeps the administrative route on its own gate', async () => {
    visit('/app/admin');
    render(<AppShellView />);

    await waitFor(() => {
      expect(within(screen.getByRole('main')).getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'My Diagrams' })).not.toBeInTheDocument();
  });

  it('does not load diagrams on the administrative route', async () => {
    visit('/app/admin');
    render(<AppShellView />);

    await waitFor(() => {
      expect(screen.getByRole('main')).not.toBeEmptyDOMElement();
    });
    expect(mockListDiagrams).not.toHaveBeenCalled();
  });

  it('leaves the editor route to its own phase', () => {
    visit('/app/diagram/abc');
    render(<AppShellView />);

    expect(screen.getByText(/loading editor/iu)).toBeInTheDocument();
    expect(mockListDiagrams).not.toHaveBeenCalled();
  });
});
