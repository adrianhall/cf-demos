import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AppShellView } from '../../src/client/views/AppShellView.tsx';
import { BlueprintsView } from '../../src/client/views/BlueprintsView.tsx';

/**
 * @file Covers the two views whose own behaviour is the Access posture they pass to the shared
 *   banner, plus the authenticated shell's administrative gate. The gate is presentation rather
 *   than authorization — the server re-checks every administrative route — but it must not flash a
 *   refusal at the real administrator while their identity is still resolving, which is a
 *   behavioural requirement a DOM test can actually hold.
 */

/**
 * Original location descriptor, restored after each test.
 */
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * Points `window.location.pathname` at a path. Jsdom's `location` is read-only, so it is replaced
 * wholesale rather than mutated.
 *
 * @param pathname Path the view should resolve.
 */
function visit(pathname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname },
    writable: true
  });
}

/**
 * Stubs `GET /api/me` with one identity.
 *
 * @param identity Response body, or `null` to answer `401` as Access does for an anonymous caller.
 */
function stubIdentity(identity: { email: string; isAdmin: boolean } | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      identity === null
        ? new Response(JSON.stringify({ detail: 'Authentication required.' }), { status: 401 })
        : new Response(JSON.stringify(identity), {
            headers: { 'content-type': 'application/json' }
          })
    )
  );
}

/**
 * Stubs a `fetch` that never settles, holding the identity in its loading state.
 */
function stubPendingIdentity(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Promise<Response>(() => {}))
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn()
    }))
  );
  localStorage.clear();
  visit('/app');
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('BlueprintsView', () => {
  it('renders the shared banner in its public posture', async () => {
    stubIdentity(null);
    render(<BlueprintsView />);

    // Public posture: an anonymous visitor is offered Sign in and shown no error, because a failed
    // identity request on a public page means "not signed in".
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /sign in/iu })).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a returning signed-in visitor their identity and Sign out', async () => {
    stubIdentity({ email: 'alice@example.com', isAdmin: false });
    render(<BlueprintsView />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
  });

  it('heads the page with its own level-one heading', () => {
    stubIdentity(null);
    render(<BlueprintsView />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Start a new diagram');
  });
});

describe('AppShellView', () => {
  describe('the banner', () => {
    it('renders the banner in its authenticated posture on the dashboard', async () => {
      stubIdentity({ email: 'alice@example.com', isAdmin: false });
      render(<AppShellView />);

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument();
      });
      // Unconditional on this subtree, so a presenter signed in as the wrong identity can always
      // recover.
      expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /sign in/iu })).not.toBeInTheDocument();
    });

    // The editor renders its own toolbar immediately below where this would sit, whose back control
    // already reaches a view with the header and its sign-out control.
    it('suppresses the banner on the editor route', () => {
      visit('/app/diagram/abc');
      stubIdentity({ email: 'alice@example.com', isAdmin: false });
      render(<AppShellView />);

      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    });

    it('renders the banner on the dashboard and administrative routes', () => {
      for (const pathname of ['/app', '/app/admin']) {
        visit(pathname);
        stubIdentity({ email: 'admin@example.com', isAdmin: true });
        const { unmount } = render(<AppShellView />);

        expect(screen.getByRole('banner')).toBeInTheDocument();
        unmount();
      }
    });

    it('gives the editor route its full-viewport main region', () => {
      visit('/app/diagram/abc');
      stubIdentity({ email: 'alice@example.com', isAdmin: false });
      render(<AppShellView />);

      expect(screen.getByRole('main')).toHaveClass('app-shell__main--editor');
    });

    it('gives the dashboard the centred, padded main region', () => {
      stubIdentity({ email: 'alice@example.com', isAdmin: false });
      render(<AppShellView />);

      expect(screen.getByRole('main')).not.toHaveClass('app-shell__main--editor');
    });
  });

  describe('the administrative gate', () => {
    it('admits the identity the server reported as the administrator', async () => {
      visit('/app/admin');
      stubIdentity({ email: 'admin@example.com', isAdmin: true });
      render(<AppShellView />);

      await waitFor(() => {
        expect(
          within(screen.getByRole('main')).getByRole('heading', { name: 'Administration' })
        ).toBeInTheDocument();
      });
    });

    it('refuses an identity the server did not report as the administrator', async () => {
      visit('/app/admin');
      stubIdentity({ email: 'alice@example.com', isAdmin: false });
      render(<AppShellView />);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/only available to this demo/iu);
      });
    });

    // `isAdmin` is false until `/api/me` resolves, so rendering the refusal immediately would flash
    // "not allowed" at the actual administrator on every single load.
    it('waits rather than refusing while the identity is still resolving', () => {
      visit('/app/admin');
      stubPendingIdentity();
      render(<AppShellView />);

      const main = screen.getByRole('main');

      expect(within(main).getByText(/verifying identity/iu)).toBeInTheDocument();
      expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
    });

    // The gate is presentation. Hiding the surface is not the control — every `/api/admin/*` route
    // compares the verified identity to `ADMIN_EMAIL` itself, which is what actually stops a
    // non-administrator who navigates straight here.
    it('refuses a visitor whose identity request failed outright', async () => {
      visit('/app/admin');
      stubIdentity(null);
      render(<AppShellView />);

      await waitFor(() => {
        expect(within(screen.getByRole('main')).getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  describe('identity resolution', () => {
    // The shell needs `isAdmin` for its own gate, so it resolves the identity once and passes it
    // down. A header that resolved it again would double every `/api/me` request on this subtree.
    it('requests the identity exactly once for the shell and its banner together', async () => {
      visit('/app/admin');
      stubIdentity({ email: 'admin@example.com', isAdmin: true });
      render(<AppShellView />);

      await waitFor(() => {
        expect(
          within(screen.getByRole('main')).getByRole('heading', { name: 'Administration' })
        ).toBeInTheDocument();
      });
      // One `/api/me`. The administrative view's own `/api/admin/users` is a second call to a
      // different endpoint, so the count is taken over the identity requests only.
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => input === '/api/me')).toHaveLength(1);
    });
  });
});
