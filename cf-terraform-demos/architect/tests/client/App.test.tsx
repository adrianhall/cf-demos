import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

afterEach(() => {
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
    it.each(['/app', '/app/', '/app/admin', '/app/diagram/123'])(
      'renders the authenticated shell for %s',
      (pathname) => {
        visit(pathname);
        render(<App />);

        expect(screen.getByText(/loading/iu)).toBeInTheDocument();
      }
    );
  });

  describe('the Access boundary', () => {
    // The landing page's link into the editor must be an ordinary anchor with a real href. A
    // button with an onClick handler would resolve the path inside an already-loaded bundle,
    // which is precisely the point at which Access can no longer intercept it.
    it('links into /app with a real document navigation', () => {
      visit('/');
      render(<App />);

      const link = screen.getByRole('link', { name: /open the editor/iu });

      expect(link).toHaveAttribute('href', '/app');
    });

    it('links to the public blueprint gallery with a real anchor too', () => {
      visit('/');
      render(<App />);

      expect(screen.getByRole('link', { name: /browse blueprints/iu })).toHaveAttribute(
        'href',
        '/blueprints'
      );
    });
  });
});
