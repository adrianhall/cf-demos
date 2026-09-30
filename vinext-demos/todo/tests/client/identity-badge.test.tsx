import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { IdentityBadge } from '../../src/ui/identity-badge';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('IdentityBadge', () => {
  it('shows the identity the Worker verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ email: 'alice@example.com' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          })
        )
      )
    );
    render(<IdentityBadge />);

    expect(screen.getByText('Verifying identity…')).toBeVisible();
    expect(await screen.findByText('alice@example.com')).toBeVisible();
  });

  // An expired Access session answers /api/me with 401. The badge is cosmetic, so it must fail
  // quietly rather than rendering an error over a page that is otherwise usable.
  it('renders nothing when the session cannot be verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 })))
    );
    const { container } = render(<IdentityBadge />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the identity request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    const { container } = render(<IdentityBadge />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
