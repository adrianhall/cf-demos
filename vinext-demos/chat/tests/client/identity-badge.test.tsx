import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { IdentityBadge } from '../../src/ui/identity-badge';

/**
 * The stubbed `fetch`, typed by its real signature so a promise-returning implementation is not
 * reported as a misused promise by type-aware lint.
 */
let fetchMock: Mock<(path: string) => Promise<Response>>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ email: 'alice@example.com' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    )
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('IdentityBadge', () => {
  it('shows the Worker’s verified view of the signed-in identity', async () => {
    render(<IdentityBadge />);

    expect(await screen.findByText('alice@example.com')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith('/api/me');
  });

  it('shows a transient label while the identity is being verified', () => {
    render(<IdentityBadge />);

    expect(screen.getByText('Verifying identity…')).toBeVisible();
  });

  // The visitor is already past Cloudflare Access by the time this runs, so an unavailable
  // indicator is cosmetic — it must not become an error the reader has to dismiss.
  it('renders nothing once an expired session is reported', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { container } = render(<IdentityBadge />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the identity request fails outright', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { container } = render(<IdentityBadge />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
