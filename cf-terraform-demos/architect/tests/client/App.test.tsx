import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../../src/client/App.tsx';

/**
 * @file The path selector is the one piece of routing this application has, and it is load-bearing
 *   for authorization rather than merely for navigation: the `/app*` boundary must stay a real
 *   browser navigation so Cloudflare Access can intercept the document request before any bundle
 *   runs. These tests pin the mapping so a future refactor towards a client-side router fails here
 *   rather than silently removing the interception point.
 */

/**
 * Original location descriptor, restored after each test.
 */
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * Points `window.location.pathname` at a path.
 *
 * Jsdom's `location` is read-only, so it is replaced wholesale rather than mutated.
 *
 * @param pathname Path the component should resolve.
 */
function visit(pathname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname },
    writable: true
  });
}

beforeEach(() => {
  visit('/');

  // Every view now renders the shared banner, which resolves the identity on mount and mounts the
  // appearance control. Neither is what these tests are about, so both are stubbed to the state
  // that renders the least: an anonymous visitor with a light OS preference. The header's own suite
  // covers every other combination.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn()
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('App path selector', () => {
  describe('public paths', () => {
    it.each(['/', '/about', '/anything-unrecognised'])(
      'renders the landing page for %s',
      (pathname) => {
        visit(pathname);
        render(<App />);

        expect(
          screen.getByRole('heading', { name: /design your cloudflare architecture/iu })
        ).toBeInTheDocument();
      }
    );

    it('renders the blueprint gallery for /blueprints', () => {
      visit('/blueprints');
      render(<App />);

      expect(screen.getByRole('heading', { name: /start a new diagram/iu })).toBeInTheDocument();
    });

    it('renders the share viewer for /s/:token', () => {
      visit('/s/abc123');
      render(<App />);

      expect(screen.getByText(/loading shared diagram/iu)).toBeInTheDocument();
    });

    it('renders the share viewer for a trailing-slash share path', () => {
      visit('/s/abc123/');
      render(<App />);

      expect(screen.getByText(/loading shared diagram/iu)).toBeInTheDocument();
    });

    // A share token can be URL-encoded in the path; the viewer must receive the decoded value,
    // because the server compares a digest of the raw token.
    it('decodes a percent-encoded share token', () => {
      visit('/s/a%2Fb');
      render(<App />);

      expect(screen.getByText(/loading shared diagram/iu)).toBeInTheDocument();
    });

    // `/s/` with no token is not a share link. Falling through to the landing page rather than
    // rendering an empty viewer keeps the viewer from ever resolving an empty token.
    it('falls through to the landing page for /s/ with no token', () => {
      visit('/s/');
      render(<App />);

      expect(
        screen.getByRole('heading', { name: /design your cloudflare architecture/iu })
      ).toBeInTheDocument();
    });
  });

  describe('authenticated paths', () => {
    it.each(['/app', '/app/', '/app/diagram/123'])(
      'renders the authenticated shell for %s',
      (pathname) => {
        visit(pathname);
        render(<App />);

        expect(screen.getByText(/loading/iu)).toBeInTheDocument();
      }
    );

    // `/app/admin` reaches the shell's administrative gate rather than a view placeholder. Until
    // `/api/me` resolves — which it never does for the anonymous stub here — the gate shows the
    // wait state, because rendering the refusal immediately would flash "not allowed" at the
    // actual administrator on every load.
    //
    // Scoped to `<main>` because the header shows its own identity wait state on this posture, so
    // an unscoped query matches both and tells us nothing about which one rendered.
    it('renders the authenticated shell for /app/admin', () => {
      visit('/app/admin');
      render(<App />);

      expect(screen.getByRole('main')).toHaveTextContent(/verifying identity/iu);
    });
  });

  describe('the Access boundary', () => {
    // The landing page's links into the editor must be ordinary anchors with real hrefs. A button
    // with an onClick handler would resolve the path inside an already-loaded bundle, which is
    // precisely the point at which Access can no longer intercept it.
    //
    // Both the hero and the closing call-to-action banner offer the same pair, so these assert
    // every matching link rather than a single one — a regression that broke only the second
    // instance would otherwise pass.
    it('links into /app with a real document navigation', () => {
      visit('/');
      render(<App />);

      const links = screen.getAllByRole('link', { name: /open the editor/iu });

      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.tagName).toBe('A');
        expect(link).toHaveAttribute('href', '/app');
      }
    });

    it('links to the public blueprint gallery with real anchors too', () => {
      visit('/');
      render(<App />);

      const links = screen.getAllByRole('link', { name: /browse blueprints/iu });

      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).toHaveAttribute('href', '/blueprints');
      }
    });
  });
});
