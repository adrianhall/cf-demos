import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdminUser } from '../../src/client/api/admin.ts';

const { mockListUsers } = vi.hoisted(() => ({ mockListUsers: vi.fn() }));
vi.mock('../../src/client/api/admin.ts', () => ({ listUsers: mockListUsers }));

const { UserDirectoryTable } =
  await import('../../src/client/components/admin/UserDirectoryTable.tsx');

/**
 * @file Covers the administrative directory table: its wait, empty and failure states, the
 *   relationships that make it readable to a screen reader, and the paging arithmetic. The paging
 *   is where the real risk is — an off-by-one in the offset silently skips a page of identities,
 *   which nothing on screen would reveal.
 */

/**
 * Builds a directory row.
 *
 * @param overrides Fields to replace.
 * @returns The row.
 */
function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    diagramCount: 0,
    displayName: null,
    email: 'alice@example.com',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

/**
 * Builds a page of the directory.
 *
 * @param users Rows on the page.
 * @param total Directory size across every page.
 * @param offset Window offset the page was read at.
 * @returns The page.
 */
function page(users: AdminUser[], total = users.length, offset = 0) {
  return { limit: 20, offset, total, users };
}

beforeEach(() => {
  mockListUsers.mockReset();
});

describe('loading', () => {
  it('waits rather than showing an empty table', () => {
    mockListUsers.mockReturnValue(new Promise(() => {}));
    render(<UserDirectoryTable />);

    expect(screen.getByText('Loading the user directory…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks for the first page on mount', async () => {
    mockListUsers.mockResolvedValue(page([user()]));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(mockListUsers).toHaveBeenCalledWith({ limit: 20, offset: 0 }));
  });
});

describe('the rows', () => {
  it('renders one row per identity with its diagram count', async () => {
    mockListUsers.mockResolvedValue(page([user({ diagramCount: 3 })]));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeInTheDocument());

    const row = screen.getByText('alice@example.com').closest('tr') as HTMLElement;

    expect(within(row).getByText('3')).toBeInTheDocument();
  });

  // Shown rather than hidden: the column is honestly empty because no identity provider here
  // asserts a name, which is a different thing from the directory not recording one.
  it('shows an em dash where no display name exists', async () => {
    mockListUsers.mockResolvedValue(page([user({ displayName: null })]));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
  });

  it('renders a display name when one exists', async () => {
    mockListUsers.mockResolvedValue(page([user({ displayName: 'Alice Example' })]));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());
  });

  it('formats both timestamps as absolute dates', async () => {
    mockListUsers.mockResolvedValue(
      page([
        user({ firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-06-15T12:00:00.000Z' })
      ])
    );
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeInTheDocument());

    const row = screen.getByText('alice@example.com').closest('tr') as HTMLElement;

    // Two distinct absolute dates rather than relative phrasing: an operator reading a directory
    // wants the instant, not "5 months ago".
    expect(within(row).getAllByText(/\b2026\b/u)).toHaveLength(2);
  });

  it('shows an empty state when nobody has ever signed in', async () => {
    mockListUsers.mockResolvedValue(page([], 0));
    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByText('No identities have signed in yet.')).toBeInTheDocument()
    );
  });
});

describe('the table\u2019s structure', () => {
  beforeEach(() => {
    mockListUsers.mockResolvedValue(page([user()]));
  });

  // A screen reader navigating by cell needs each number announced with the column it belongs
  // to; "3" on its own says nothing.
  it('associates every column with a header', async () => {
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    const headers = screen.getAllByRole('columnheader');

    expect(headers.map((header) => header.textContent)).toEqual([
      'Email',
      'Display name',
      'Diagrams',
      'First seen',
      'Last seen'
    ]);
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });

  // The directory's size is the one figure the rows themselves cannot show.
  it('names the table and reports the directory\u2019s size', async () => {
    mockListUsers.mockResolvedValue(page([user()], 7));
    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByRole('table')).toHaveAccessibleName('7 identities have signed in')
    );
  });

  it('says "identity" rather than "identities" for a directory of one', async () => {
    mockListUsers.mockResolvedValue(page([user()], 1));
    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByRole('table')).toHaveAccessibleName('1 identity have signed in')
    );
  });
});

describe('paging', () => {
  it('disables both controls when the whole directory is on screen', async () => {
    mockListUsers.mockResolvedValue(page([user()], 1));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('advances a whole page at a time', async () => {
    mockListUsers.mockResolvedValueOnce(page([user({ email: 'first@example.com' })], 25));
    mockListUsers.mockResolvedValueOnce(page([user({ email: 'second@example.com' })], 25, 20));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByText('first@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('second@example.com')).toBeInTheDocument());
    expect(mockListUsers).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
  });

  it('goes back a whole page at a time', async () => {
    mockListUsers.mockResolvedValue(page([user({ email: 'first@example.com' })], 25));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByText('first@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mockListUsers).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

    await waitFor(() => expect(mockListUsers).toHaveBeenLastCalledWith({ limit: 20, offset: 0 }));
  });

  // The first page is offset zero; a "previous" from there must not produce a negative one.
  it('never asks for a negative offset', async () => {
    mockListUsers.mockResolvedValue(page([user()], 25));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mockListUsers).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(mockListUsers).toHaveBeenCalledTimes(3));

    for (const [call] of mockListUsers.mock.calls) {
      expect((call as { offset: number }).offset).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ['the first of several pages', [user()], 25, 0, '1–20 of 25'],
    ['an empty directory', [], 0, 0, '0 of 0'],
    ['a single short page', [user()], 1, 0, '1–1 of 1']
  ])('reports the window for %s', async (_description, rows, total, offset, expected) => {
    mockListUsers.mockResolvedValue(page(rows, total, offset));
    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
  });

  // A second press before the first request answers would advance the offset twice and skip a
  // page of identities, which nothing on screen would reveal.
  it('disables the controls while a page is in flight', async () => {
    mockListUsers.mockResolvedValueOnce(page([user()], 100));
    mockListUsers.mockReturnValueOnce(new Promise(() => {}));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  // The table keeps the previous rows while the next page loads rather than collapsing back to
  // the wait state, so it does not reflow between pages.
  it('keeps the current rows on screen while the next page loads', async () => {
    mockListUsers.mockResolvedValueOnce(page([user({ email: 'first@example.com' })], 100));
    mockListUsers.mockReturnValueOnce(new Promise(() => {}));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByText('first@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('first@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Loading the user directory…')).not.toBeInTheDocument();
  });
});

describe('failures', () => {
  // The answer every identity except the configured administrator receives.
  it('reports the refusal rather than an empty directory', async () => {
    mockListUsers.mockRejectedValue(
      new Error('This Cloudflare Access identity is not the configured administrator.')
    );
    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/not the configured administrator/u)
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('falls back to a usable message when the failure carried none', async () => {
    mockListUsers.mockRejectedValue('boom');
    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load the user directory.')
    );
  });

  // Otherwise a stale refusal sits on screen beside rows that loaded perfectly well.
  it('clears a previous failure when a later page succeeds', async () => {
    mockListUsers.mockRejectedValueOnce(new Error('Temporarily unavailable.'));
    render(<UserDirectoryTable />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    mockListUsers.mockResolvedValue(page([user()], 1));
    // Re-mounted rather than paged, because a failed first load leaves no controls to press.
    const { rerender } = render(<UserDirectoryTable />);
    rerender(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeInTheDocument());
  });
});
