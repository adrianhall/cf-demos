import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

/**
 * @file Covers the dashboard's "Shared with me" section. Two of its behaviours are deliberate
 *   absences rather than features — it renders nothing when there is nothing to show, and nothing
 *   when the request fails — so those are asserted as outcomes a visitor would see, because an
 *   implementation that rendered an empty box or a red alert would pass any test that only checked
 *   the happy path.
 */

const { mockListDiagrams, mockListSharedWithMe } = vi.hoisted(() => ({
  mockListDiagrams: vi.fn(),
  mockListSharedWithMe: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  deleteDiagram: vi.fn(),
  duplicateDiagram: vi.fn(),
  listDiagrams: mockListDiagrams,
  listSharedWithMe: mockListSharedWithMe
}));

const { DashboardView } = await import('../../src/client/views/DashboardView.tsx');
const { SharedWithMeGrid } =
  await import('../../src/client/components/dashboard/SharedWithMeGrid.tsx');

const OWNER = 'alice@example.com';

/**
 * Builds a diagram of the shape the API returns.
 *
 * @param overrides Fields to override on the returned diagram.
 * @returns The diagram.
 */
function diagram(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    description: null,
    graphData: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    id: 'shared-1',
    ownerEmail: OWNER,
    title: 'Shared Diagram',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

beforeEach(() => {
  mockListDiagrams.mockReset().mockResolvedValue([]);
  mockListSharedWithMe.mockReset().mockResolvedValue([]);
});

describe('the shared section on its own', () => {
  it('lists a diagram somebody else shared, linking to the same editor', async () => {
    mockListSharedWithMe.mockResolvedValue([diagram()]);
    render(<SharedWithMeGrid />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Shared Diagram' })).toHaveAttribute(
        'href',
        '/app/diagram/shared-1'
      );
    });
  });

  // The one visible difference from an owned card, and the reason the card takes a slot for it:
  // without the owner's address, two diagrams with the same title in the two sections would be
  // indistinguishable.
  it('names the owner on the card', async () => {
    mockListSharedWithMe.mockResolvedValue([diagram()]);
    render(<SharedWithMeGrid />);

    await waitFor(() => {
      expect(screen.getByText(`Shared by ${OWNER}`)).toBeInTheDocument();
    });
  });

  it('is headed so the two sections can be told apart', async () => {
    mockListSharedWithMe.mockResolvedValue([diagram()]);
    render(<SharedWithMeGrid />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
    });
  });

  // An empty "Shared with me" is the ordinary case for most people, so a standing empty box
  // saying so would be noise on every dashboard — unlike an empty "My Diagrams", which is a
  // prompt to create one.
  it('renders nothing at all when nobody has shared anything', async () => {
    const { container } = render(<SharedWithMeGrid />);

    await waitFor(() => expect(mockListSharedWithMe).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // This section is secondary to the visitor's own diagrams, which load independently above it. A
  // red alert about a list they may not even use would misreport the state of the page.
  it('renders nothing, and no alert, when the request fails', async () => {
    mockListSharedWithMe.mockRejectedValue(new Error('Request failed.'));
    const { container } = render(<SharedWithMeGrid />);

    await waitFor(() => expect(mockListSharedWithMe).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Duplicate and Delete are owner-only server-side, so offering them here would be offering
  // actions the server refuses. Leaving a diagram lives in the editor, beside the list of who
  // else has access.
  it('offers no per-card actions on somebody else\u2019s diagram', async () => {
    mockListSharedWithMe.mockResolvedValue([diagram()]);
    render(<SharedWithMeGrid />);

    await waitFor(() => expect(screen.getByText('Shared Diagram')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Actions for/u })).not.toBeInTheDocument();
  });

  it('discards a response that arrives after the dashboard has gone', async () => {
    let resolve: (value: unknown[]) => void = () => {};
    mockListSharedWithMe.mockReturnValue(
      new Promise((settle) => {
        resolve = settle as (value: unknown[]) => void;
      })
    );
    const { unmount } = render(<SharedWithMeGrid />);

    unmount();
    resolve([diagram()]);

    await waitFor(() => expect(screen.queryByText('Shared Diagram')).not.toBeInTheDocument());
  });
});

describe('the dashboard as a whole', () => {
  it('shows both sections, each from its own endpoint', async () => {
    mockListDiagrams.mockResolvedValue([diagram({ id: 'own-1', title: 'My Own' })]);
    mockListSharedWithMe.mockResolvedValue([diagram({ title: 'From A Colleague' })]);
    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'My Diagrams' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
    expect(screen.getByText('My Own')).toBeInTheDocument();
    expect(screen.getByText('From A Colleague')).toBeInTheDocument();
  });

  // An owned card must not sprout an owner badge: every card in that section belongs to the
  // visitor, so the line would repeat on each one and say nothing.
  it('names an owner only in the shared section', async () => {
    mockListDiagrams.mockResolvedValue([diagram({ id: 'own-1', title: 'My Own' })]);
    mockListSharedWithMe.mockResolvedValue([diagram({ title: 'From A Colleague' })]);
    render(<DashboardView />);

    await waitFor(() => expect(screen.getByText('From A Colleague')).toBeInTheDocument());
    expect(screen.getAllByText(`Shared by ${OWNER}`)).toHaveLength(1);
  });

  // Each section loads independently, so a failure in one must not blank the other.
  it('still shows the visitor\u2019s own diagrams when the shared list fails', async () => {
    mockListDiagrams.mockResolvedValue([diagram({ id: 'own-1', title: 'My Own' })]);
    mockListSharedWithMe.mockRejectedValue(new Error('Request failed.'));
    render(<DashboardView />);

    await waitFor(() => expect(screen.getByText('My Own')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Shared with me' })).not.toBeInTheDocument();
  });

  it('still shows the shared section when the visitor owns nothing', async () => {
    mockListSharedWithMe.mockResolvedValue([diagram({ title: 'From A Colleague' })]);
    render(<DashboardView />);

    await waitFor(() => expect(screen.getByText('From A Colleague')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'No diagrams yet' })).toBeInTheDocument();
  });
});
