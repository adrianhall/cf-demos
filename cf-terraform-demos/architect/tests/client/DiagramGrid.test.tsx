import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DiagramSummary } from '../../src/client/api/diagrams.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { mockDeleteDiagram, mockDuplicateDiagram, mockListDiagrams } = vi.hoisted(() => ({
  mockDeleteDiagram: vi.fn(),
  mockDuplicateDiagram: vi.fn(),
  mockListDiagrams: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  deleteDiagram: mockDeleteDiagram,
  duplicateDiagram: mockDuplicateDiagram,
  listDiagrams: mockListDiagrams
}));

const { DiagramGrid } = await import('../../src/client/components/dashboard/DiagramGrid.tsx');

/**
 * @file Covers the dashboard: its three load states, its card structure, its overflow menu, and the
 *   confirmation that stands in front of an unrecoverable delete. The menu-dismissal cases are not
 *   padding. A menu that closes only on an outside click leaves a keyboard user unable to dismiss
 *   it at all, which is the defect the shared hook exists to prevent, and only a test at this level
 *   exercises it through a real menu.
 */

/**
 * Builds a diagram with sensible defaults.
 *
 * @param overrides Fields to replace.
 * @returns A diagram payload as the API would return it.
 */
function diagram(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    description: null,
    graphData: JSON.stringify({ edges: [], nodes: [{ id: 'a' }] }),
    id: 'd1',
    ownerEmail: 'alice@example.com',
    title: 'My Diagram',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

beforeEach(() => {
  mockListDiagrams.mockReset();
  mockDeleteDiagram.mockReset().mockResolvedValue(undefined);
  mockDuplicateDiagram.mockReset();
});

describe('load states', () => {
  it('shows a wait state before the list resolves', () => {
    mockListDiagrams.mockReturnValue(new Promise(() => {}));
    render(<DiagramGrid />);

    expect(screen.getByText(/loading your diagrams/iu)).toBeInTheDocument();
  });

  it('announces a load failure with the server\u2019s own message', async () => {
    mockListDiagrams.mockRejectedValue(new Error('Authentication required.'));
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Authentication required.');
    });
  });

  it('falls back to a generic message when the failure is not an Error', async () => {
    mockListDiagrams.mockRejectedValue('boom');
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load your diagrams.');
    });
  });

  it('offers a route into the gallery when the visitor has no diagrams yet', async () => {
    mockListDiagrams.mockResolvedValue([]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByText(/no diagrams yet/iu)).toBeInTheDocument();
    });
    // The gallery, not a contextless form: choosing a starting point and naming the diagram are
    // one decision, and the starting points live there.
    expect(screen.getByRole('link', { name: /new diagram/iu })).toHaveAttribute(
      'href',
      '/blueprints'
    );
  });

  // The empty state owns the rhythm of all three pieces. It must not depend on browser default
  // margins: those happen to space h2 → p, but the final button is an inline anchor and sits flush
  // against the paragraph in some browsers unless the container supplies a gap.
  it('keeps the empty-state heading, prose and CTA as one deliberate layout group', async () => {
    mockListDiagrams.mockResolvedValue([]);
    render(<DiagramGrid />);

    const heading = await screen.findByRole('heading', { name: 'No diagrams yet' });
    const empty = heading.closest('.dashboard__empty');

    expect(empty).not.toBeNull();
    expect(empty?.children).toHaveLength(3);
    expect(empty?.children[0]).toBe(heading);
    expect(empty?.children[1]).toHaveTextContent(
      'Create your first Cloudflare architecture diagram to get started.'
    );
    expect(empty?.children[2]).toBe(screen.getByRole('link', { name: /new diagram/iu }));
  });

  it('heads the populated dashboard and links to the gallery', async () => {
    mockListDiagrams.mockResolvedValue([diagram()]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My Diagrams');
    });
    expect(screen.getByRole('link', { name: /new diagram/iu })).toHaveAttribute(
      'href',
      '/blueprints'
    );
  });
});

describe('cards', () => {
  it('renders one card per diagram, each linking to its editor', async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: 'd1', title: 'First' }),
      diagram({ id: 'd2', title: 'Second' })
    ]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'First' })).toHaveAttribute(
        'href',
        '/app/diagram/d1'
      );
    });
    expect(screen.getByRole('link', { name: 'Second' })).toHaveAttribute('href', '/app/diagram/d2');
  });

  it('renders a real thumbnail of each diagram\u2019s own graph', async () => {
    mockListDiagrams.mockResolvedValue([diagram()]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toHaveAttribute('data-node-count', '1');
    });
  });

  it('shows a relative timestamp and the exact dates for assistive technology', async () => {
    // Offsets from the real clock rather than fake timers, which `waitFor`'s polling does not
    // advance, and far enough from a unit boundary that "2 days ago" is unambiguous.
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const updatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    mockListDiagrams.mockResolvedValue([diagram({ createdAt, updatedAt })]);
    const { container } = render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'My Diagram' })).toBeInTheDocument();
    });

    const timestamp = container.querySelector('.diagram-card__timestamp');

    expect(timestamp?.tagName).toBe('TIME');
    expect(timestamp).toHaveAttribute('datetime', updatedAt);
    expect(timestamp?.textContent).toContain('Updated 2 days ago');
    expect(timestamp).toHaveAttribute('title', expect.stringContaining('Created') as string);
  });

  // Invalid markup, and a screen reader would describe a button inside a link to the same place.
  it('nests no control inside the card\u2019s stretched title link', async () => {
    mockListDiagrams.mockResolvedValue([diagram()]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'My Diagram' })).toBeInTheDocument();
    });

    expect(
      screen.getByRole('link', { name: 'My Diagram' }).querySelectorAll('button')
    ).toHaveLength(0);
  });

  it('names each card\u2019s menu after its own diagram', async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: 'd1', title: 'First' }),
      diagram({ id: 'd2', title: 'Second' })
    ]);
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions for First' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Actions for Second' })).toBeInTheDocument();
  });
});

describe('the overflow menu', () => {
  beforeEach(() => {
    mockListDiagrams.mockResolvedValue([diagram({ title: 'Menu Test' })]);
  });

  /**
   * Renders the grid and opens the single card's menu.
   *
   * @returns A promise fulfilled once the menu is open.
   */
  async function openMenu(): Promise<void> {
    render(<DiagramGrid />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions for Menu Test' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Menu Test' }));
  }

  it('reports its expanded state', async () => {
    await openMenu();

    expect(screen.getByRole('button', { name: 'Actions for Menu Test' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // The keyboard path. Without it a keyboard user cannot dismiss the menu at all.
  it('dismisses on Escape', async () => {
    await openMenu();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dismisses on a press outside it', async () => {
    await openMenu();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays open on a press inside it', async () => {
    await openMenu();

    fireEvent.mouseDown(screen.getByRole('menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('stays open on a key other than Escape', async () => {
    await openMenu();

    fireEvent.keyDown(document, { key: 'Enter' });

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes when its trigger is pressed again', async () => {
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Menu Test' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('duplicating', () => {
  it('duplicates by id and refreshes the list from the server', async () => {
    const original = diagram({ id: 'd1', title: 'Original' });
    mockListDiagrams
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([original, diagram({ id: 'd2', title: 'Original (copy)' })]);
    mockDuplicateDiagram.mockResolvedValue(diagram({ id: 'd2', title: 'Original (copy)' }));
    render(<DiagramGrid />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Original' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Original' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    // The id, not the whole diagram: the server copies the graph, so the client does not need to
    // hold one.
    await waitFor(() => {
      expect(mockDuplicateDiagram).toHaveBeenCalledWith('d1');
    });
    // Reloaded rather than appended locally, so the card arrives with the server's own id and
    // timestamps and the list keeps the server's ordering.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Original (copy)' })).toBeInTheDocument();
    });
  });
});

describe('deleting', () => {
  beforeEach(() => {
    mockListDiagrams.mockResolvedValue([diagram({ id: 'd1', title: 'To Delete' })]);
  });

  /**
   * Renders the grid and opens the deletion confirmation for its single card.
   *
   * @returns A promise fulfilled once the confirmation is open.
   */
  async function openConfirmation(): Promise<void> {
    render(<DiagramGrid />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'To Delete' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for To Delete' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  }

  // Deletion is unrecoverable here — no trash, no undo — so the confirmation naming the diagram is
  // the point of it.
  it('confirms first, naming the diagram, through an alertdialog', async () => {
    await openConfirmation();

    const dialog = screen.getByRole('alertdialog');

    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('To Delete');
    expect(dialog).toHaveTextContent(/cannot be undone/iu);
    expect(mockDeleteDiagram).not.toHaveBeenCalled();
  });

  it('deletes once confirmed and removes the card at once', async () => {
    await openConfirmation();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteDiagram).toHaveBeenCalledWith('d1');
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'To Delete' })).not.toBeInTheDocument();
    });
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['the close control', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['the backdrop', () => fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })]
  ])('keeps the diagram when dismissed through %s', async (_label, dismiss) => {
    await openConfirmation();

    dismiss();

    expect(mockDeleteDiagram).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'To Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('moves focus into the confirmation when it opens', async () => {
    await openConfirmation();

    expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
  });
});
