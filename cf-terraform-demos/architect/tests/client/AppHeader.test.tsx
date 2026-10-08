import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AppHeader,
  type AppHeaderAccess,
  type AppHeaderPage
} from '../../src/client/components/AppHeader.tsx';
import type { IdentityState } from '../../src/client/hooks/useIdentity.ts';

/**
 * @file Covers all three header states and the Access-posture seam between them. The cases that
 *   matter are the ones where the _same_ identity state must render differently depending on
 *   posture: an unresolved identity is a fault on the gated subtree and the normal case on a public
 *   page, and conflating the two either alarms anonymous visitors or hides a real failure.
 */

/**
 * An anonymous visitor whose identity request has resolved.
 */
const ANONYMOUS: IdentityState = { email: null, error: null, isAdmin: false, loading: false };

/**
 * An identity request still in flight.
 */
const LOADING: IdentityState = { email: null, error: null, isAdmin: false, loading: true };

/**
 * An ordinary signed-in owner.
 */
const ALICE: IdentityState = {
  email: 'alice@example.com',
  error: null,
  isAdmin: false,
  loading: false
};

/**
 * The configured administrator.
 */
const ADMIN: IdentityState = {
  email: 'admin@example.com',
  error: null,
  isAdmin: true,
  loading: false
};

/**
 * A failed identity request.
 */
const FAILED: IdentityState = {
  email: null,
  error: 'Could not verify your Cloudflare Access identity.',
  isAdmin: false,
  loading: false
};

/**
 * Renders the header in one identity state and posture.
 *
 * @param identity Identity state to render.
 * @param access Access posture of the hosting page.
 * @param current Page rendering the header.
 */
function renderHeader(
  identity: IdentityState,
  access: AppHeaderAccess,
  current: AppHeaderPage = 'landing'
): void {
  render(<AppHeader identity={identity} access={access} current={current} />);
}

beforeEach(() => {
  // The header mounts the appearance control, which reads the OS preference on mount.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn()
    }))
  );
  localStorage.clear();
});

describe('AppHeader', () => {
  describe('the anonymous public state', () => {
    it('shows the brand, the appearance control and Sign in', () => {
      renderHeader(ANONYMOUS, 'public');

      expect(screen.getByRole('link', { name: 'Architect' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /appearance/iu })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign in/iu })).toBeInTheDocument();
    });

    it('offers no sign-out control', () => {
      renderHeader(ANONYMOUS, 'public');

      expect(screen.queryByRole('link', { name: /sign out/iu })).not.toBeInTheDocument();
    });

    // Navigating to `/app` *is* the sign-in flow: it is Access-gated, so Access challenges the
    // request and returns the visitor afterwards. A hand-built login URL would not.
    it('signs in by navigating into the gated subtree', () => {
      renderHeader(ANONYMOUS, 'public');

      expect(screen.getByRole('link', { name: /sign in/iu })).toHaveAttribute('href', '/app');
    });

    // Clicking a logo on a public page must never bounce an anonymous visitor into a login they did
    // not ask for.
    it('points the brand at the home page rather than the gated subtree', () => {
      renderHeader(ANONYMOUS, 'public');

      expect(screen.getByRole('link', { name: 'Architect' })).toHaveAttribute('href', '/');
    });

    it('shows no identity, no error and no alert', () => {
      renderHeader(ANONYMOUS, 'public');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/verifying identity/iu)).not.toBeInTheDocument();
    });

    // A failed `GET /api/me` on a public page means "not signed in". Reporting it as an error would
    // alarm every anonymous visitor, and `role="alert"` would announce the non-event aloud.
    it('treats a failed identity request as anonymous rather than an error', () => {
      renderHeader(FAILED, 'public');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(FAILED.error as string)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign in/iu })).toBeInTheDocument();
    });

    // Rendering nothing beats flickering "Sign in" into "Sign out" one frame later.
    it('offers neither control while a public identity is still resolving', () => {
      renderHeader(LOADING, 'public');

      expect(screen.queryByRole('link', { name: /sign in/iu })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /sign out/iu })).not.toBeInTheDocument();
    });
  });

  describe('the signed-in state', () => {
    it('shows the verified identity, My Diagrams, the appearance control and Sign out', () => {
      renderHeader(ALICE, 'authenticated');

      expect(screen.getByText(ALICE.email as string)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'My Diagrams' })).toHaveAttribute('href', '/app');
      expect(screen.getByRole('button', { name: /appearance/iu })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
    });

    // Ends the Cloudflare Access session, which lives in a cookie this application cannot clear —
    // so it must be Cloudflare's own endpoint rather than an application route.
    it('signs out through the Cloudflare Access logout endpoint', () => {
      renderHeader(ALICE, 'authenticated');

      expect(screen.getByRole('link', { name: /sign out/iu })).toHaveAttribute(
        'href',
        '/cdn-cgi/access/logout'
      );
    });

    // A presenter who signed in as the wrong identity must always be able to recover without
    // clearing cookies, and that cannot depend on a request having succeeded first.
    it('renders sign-out on the gated subtree even while the identity is resolving', () => {
      renderHeader(LOADING, 'authenticated');

      expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
    });

    it('reports a resolving identity on the gated subtree', () => {
      renderHeader(LOADING, 'authenticated');

      expect(screen.getByText(/verifying identity/iu)).toBeInTheDocument();
    });

    // Here the identity *was* guaranteed by the edge, so a failure is a genuine fault and belongs
    // in the accessibility tree as an alert.
    it('surfaces a failed identity request on the gated subtree as an alert', () => {
      renderHeader(FAILED, 'authenticated');

      expect(screen.getByRole('alert')).toHaveTextContent(FAILED.error as string);
    });

    it('points the brand at the diagram list', () => {
      renderHeader(ALICE, 'authenticated');

      expect(screen.getByRole('link', { name: 'Architect' })).toHaveAttribute('href', '/app');
    });

    // Even before the identity resolves: on this subtree the visitor is authenticated by
    // definition, so the destination is not actually in doubt.
    it('points the brand at the diagram list while the identity is still resolving', () => {
      renderHeader(LOADING, 'authenticated');

      expect(screen.getByRole('link', { name: 'Architect' })).toHaveAttribute('href', '/app');
    });

    it('offers a returning signed-in visitor Sign out on a public page too', () => {
      renderHeader(ALICE, 'public');

      expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /sign in/iu })).not.toBeInTheDocument();
    });

    it('points the brand at the diagram list for a signed-in visitor on a public page', () => {
      renderHeader(ALICE, 'public');

      expect(screen.getByRole('link', { name: 'Architect' })).toHaveAttribute('href', '/app');
    });
  });

  describe('the administrator state', () => {
    it('shows the Admin link only when the server reported isAdmin', () => {
      renderHeader(ADMIN, 'authenticated');

      expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/app/admin');
    });

    it.each([
      ['an ordinary owner', ALICE],
      ['an anonymous visitor', ANONYMOUS],
      ['an unresolved identity', LOADING]
    ])('hides the Admin link from %s', (_description, identity) => {
      renderHeader(identity, 'authenticated');

      expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    });

    // Visibility here is presentational only. Hiding the link is not the control: every
    // administrative route re-checks the verified identity server-side, which is what actually
    // stops a non-administrator who navigates straight to the path.
    it('still shows the administrator the identity and sign-out controls', () => {
      renderHeader(ADMIN, 'authenticated');

      expect(screen.getByText(ADMIN.email as string)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign out/iu })).toBeInTheDocument();
    });
  });

  describe('navigation links', () => {
    // Would point at the page the visitor is already on, and the dashboard carries its own heading.
    it('omits My Diagrams on the dashboard itself', () => {
      renderHeader(ALICE, 'authenticated', 'dashboard');

      expect(screen.queryByRole('link', { name: 'My Diagrams' })).not.toBeInTheDocument();
    });

    it.each(['admin', 'blueprints', 'landing', 'mcp-guide'] as const)(
      'shows My Diagrams on %s',
      (current) => {
        renderHeader(ALICE, 'authenticated', current);

        expect(screen.getByRole('link', { name: 'My Diagrams' })).toBeInTheDocument();
      }
    );

    // Offered to anonymous visitors too, which is the point: the page it leads to explains how to
    // connect an agent *before* signing in, so hiding it until after a login would withhold it
    // from the reader it was written for.
    it.each([
      ['an anonymous visitor', ANONYMOUS],
      ['a signed-in owner', ALICE]
    ])('offers %s the agent guide', (_description, identity) => {
      renderHeader(identity, 'public', 'landing');

      expect(screen.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
        'href',
        '/guides/mcp'
      );
    });

    it('omits the agent guide link on the guide itself', () => {
      renderHeader(ALICE, 'public', 'mcp-guide');

      expect(screen.queryByRole('link', { name: 'Connect an agent' })).not.toBeInTheDocument();
    });

    // The stylesheet has no global `a` rule, so an anchor without this class keeps the browser's
    // underline and link colour — which is how the source's chrome links ended up rendering as
    // underlined body text. The class is the shared opt-out, and every chrome link needs it.
    it.each([
      ['Architect', 'app-shell__name'],
      ['My Diagrams', 'app-shell__nav-link'],
      ['Admin', 'app-shell__nav-link']
    ])('gives the %s chrome link the shared non-underlined treatment', (name, expectedClass) => {
      renderHeader(ADMIN, 'authenticated', 'landing');

      const link = screen.getByRole('link', { name });

      expect(link).toHaveClass('nav-link');
      expect(link).toHaveClass(expectedClass);
    });

    // Real anchors with real destinations, not buttons with click handlers. The `/app*` boundary has
    // to be a document navigation so Cloudflare Access can intercept it before any bundle runs; a
    // handler would resolve the path inside an already-loaded bundle, past the interception point.
    it.each(['Architect', 'My Diagrams', 'Admin'])(
      'crosses the Access boundary with a real %s anchor',
      (name) => {
        renderHeader(ADMIN, 'authenticated', 'landing');

        const link = screen.getByRole('link', { name });

        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toMatch(/^\/app/u);
      }
    );
  });

  describe('layout', () => {
    // `margin-left: auto` lives on this wrapper rather than on the identity element, because the
    // identity renders nothing at all on an anonymous public page — leaving the appearance and
    // sign-in controls with no anchor and sitting left-justified against the brand.
    it('wraps the right-hand group so it stays right-justified with no identity to anchor it', () => {
      const { container } = render(
        <AppHeader identity={ANONYMOUS} access="public" current="landing" />
      );

      const actions = container.querySelector('.app-shell__actions');

      expect(actions).not.toBeNull();
      expect(actions?.querySelector('button')).not.toBeNull();
    });
  });
});
