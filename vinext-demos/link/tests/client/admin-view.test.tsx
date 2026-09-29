import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminView } from '../../src/ui/admin-view';

const link = {
  code: 'demo-code',
  createdAt: '2026-07-24T10:00:00.000Z',
  destination: 'https://example.com/original',
  updatedAt: '2026-07-24T11:00:00.000Z'
};

/**
 * Build a JSON response for mocked same-origin API calls.
 */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((path: string) => {
    if (path === '/api/me') {
      return Promise.resolve(jsonResponse({ email: 'admin@example.com' }));
    }
    if (path === '/api/links') {
      return Promise.resolve(jsonResponse({ links: [link] }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AdminView', () => {
  it('checks the Access identity, loads links, and renders a logout link', async () => {
    render(<AdminView />);
    expect(screen.getByTestId('session-checking')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log out' })).toHaveAttribute(
      'href',
      '/cdn-cgi/access/logout'
    );

    expect(await screen.findByLabelText('Managed short links')).toHaveTextContent(link.destination);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/me');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/links', {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  it('does not render management controls or load links for an unauthorized identity', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    render(<AdminView />);

    expect(await screen.findByTestId('not-allowed')).toHaveTextContent('Not allowed');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a short link and resets the form', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'admin@example.com' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ links: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ link }, 201));
    const user = userEvent.setup();
    render(<AdminView />);

    const input = await screen.findByLabelText('Destination URL');
    await user.type(input, link.destination);
    await user.click(screen.getByRole('button', { name: 'Create short link' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/links', {
      body: JSON.stringify({ destination: link.destination }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      `Created ${window.location.origin}/l/${link.code}`
    );
  });

  it('copies and deletes a managed link after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // `userEvent.setup()` installs its own clipboard stub, so replace it afterwards.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<AdminView />);

    await screen.findByLabelText('Managed short links');
    await user.click(screen.getByRole('button', { name: `Copy ${link.code}` }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/l/${link.code}`)
    );
    expect(screen.getByText('Copied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Delete ${link.code}` }));
    await waitFor(() => expect(screen.queryByText(link.destination)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/links/${link.code}`, { method: 'DELETE' });
  });

  it('edits a managed link and supports modal dismissal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'admin@example.com' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ links: [link] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ link: { ...link, destination: 'https://example.com/updated' } })
    );
    const user = userEvent.setup();
    render(<AdminView />);

    await screen.findByLabelText('Managed short links');
    await user.click(screen.getByRole('button', { name: `Edit ${link.code}` }));
    const dialog = screen.getByRole('dialog');
    const editInput = dialog.querySelector('input');
    expect(editInput).not.toBeNull();
    fireEvent.change(editInput as HTMLInputElement, {
      target: { value: 'https://example.com/updated' }
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Destination updated.');

    await user.click(screen.getByRole('button', { name: `Edit ${link.code}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
