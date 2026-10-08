import { LogIn, LogOut } from 'react-feather';
import { MCP_GUIDE_ROUTE } from '../../mcp-route.ts';
import type { IdentityState } from '../hooks/useIdentity.ts';
import { DarkModeToggle } from './DarkModeToggle.tsx';

/**
 * Cloudflare Access's own logout endpoint.
 *
 * A real link to Cloudflare's endpoint rather than an application route: the session being ended is
 * the Access session, held in a cookie this application cannot clear, so nothing the Worker could
 * serve would sign anybody out.
 */
const LOGOUT_PATH = '/cdn-cgi/access/logout';

/**
 * Which page is rendering the header. Used only to omit the nav link pointing at the page the
 * visitor is already on.
 */
export type AppHeaderPage = 'dashboard' | 'admin' | 'blueprints' | 'landing' | 'mcp-guide';

/**
 * Whether the page rendering the header sits behind Cloudflare Access.
 *
 * - `'authenticated'`: the Access-gated `/app*` subtree. A verified identity is guaranteed by the
 *   edge before this bundle runs, so a failed `GET /api/me` there is a real fault worth surfacing,
 *   and the sign-out control is rendered unconditionally.
 * - `'public'`: the landing page, the blueprint gallery and the share viewer, covered by the
 *   hostname-wide public bypass application. The visitor may legitimately be anonymous, so a failed
 *   identity request means "not signed in" rather than "something broke".
 *
 * This is the seam that keeps an expected state from being reported as an error. The same `401` is
 * a fault in one posture and the normal case in the other.
 */
export type AppHeaderAccess = 'authenticated' | 'public';

/**
 * Props for {@link AppHeader}.
 */
export interface AppHeaderProps {
  /**
   * Identity resolved by the _calling view_, not by this component.
   *
   * Taken as a prop for two reasons. The authenticated shell already needs `isAdmin` to decide what
   * to render, so calling `useIdentity()` here as well would fire a second, redundant `GET /api/me`
   * on every render of that subtree. It also leaves this component purely presentational, so its
   * every state is directly testable without stubbing `fetch`.
   */
  identity: IdentityState;
  /**
   * Page rendering the header.
   */
  current: AppHeaderPage;
  /**
   * Access posture of the page rendering the header.
   */
  access: AppHeaderAccess;
}

/**
 * The single application banner, shared by every "chrome" page: the authenticated dashboard and
 * administrative views, the public blueprint gallery, and the public landing page.
 *
 * One implementation rather than one per page, which is a correction the source arrived at rather
 * than a preference. The gallery previously carried its own ad-hoc header whose brand and
 * navigation links rendered as underlined, link-coloured body text in the wrong weight, because the
 * stylesheet has no global `a` rule and only the brand ever opted out of the browser default.
 * Consolidating means there is one banner to keep consistent, and `.nav-link` is the shared opt-out
 * — applied to chrome links only, deliberately not to links inside running prose, where removing
 * the underline would leave them indistinguishable from the surrounding text.
 *
 * The editor route renders no banner at all: it has its own toolbar immediately below where this
 * would sit, whose back control already returns to a view where the header and its sign-out control
 * are available, so stacking the two produced a second banner with no affordance of its own.
 *
 * @param props Identity, current page and Access posture; see {@link AppHeaderProps}.
 * @returns The application banner.
 */
export function AppHeader({ identity, current, access }: AppHeaderProps) {
  const signedIn = identity.email !== null;

  // On the Access-gated subtree the visitor is authenticated by definition, so the brand always
  // goes to the diagram list — including while `GET /api/me` is still in flight, where `signedIn`
  // is briefly false but the identity is not actually in doubt. On a public page an anonymous
  // visitor gets the home page instead, so clicking the logo can never bounce them into an Access
  // login they did not ask for.
  const brandHref = access === 'authenticated' || signedIn ? '/app' : '/';

  // Suppressed on the dashboard itself, where it would link to the current page and the view
  // already carries its own "My Diagrams" heading.
  const showDashboardLink = current !== 'dashboard';

  // Likewise suppressed on the guide itself. Shown to everybody, signed in or not: the page
  // explains how to connect an agent *before* signing in, so hiding it from anonymous visitors
  // would withhold it from precisely the reader it was written for.
  const showGuideLink = current !== 'mcp-guide';

  return (
    <header className="app-shell__header">
      <a className="app-shell__name nav-link" href={brandHref}>
        Architect
      </a>
      {showDashboardLink && (
        <a className="app-shell__nav-link nav-link" href="/app">
          My Diagrams
        </a>
      )}
      {showGuideLink && (
        <a className="app-shell__nav-link nav-link" href={MCP_GUIDE_ROUTE}>
          Connect an agent
        </a>
      )}
      {identity.isAdmin && (
        <a className="app-shell__nav-link nav-link" href="/app/admin">
          Admin
        </a>
      )}
      {/* A wrapper, rather than `margin-left: auto` on the identity element itself. `IdentityStatus`
          renders nothing at all on a public page while the identity request is in flight or the
          visitor is anonymous, which left the appearance control and sign-in button with no
          `margin-left: auto` anchor in that state — they fell back to sitting immediately after the
          nav links, left-justified against the brand. This wrapper always renders, so the group is
          right-justified unconditionally. */}
      <div className="app-shell__actions">
        <IdentityStatus identity={identity} access={access} />
        <DarkModeToggle />
        <AuthAction identity={identity} access={access} />
      </div>
    </header>
  );
}

/**
 * The identity slot: the verified email, or — on the Access-gated subtree only — the loading and
 * error states of the identity request.
 *
 * A public page renders nothing while loading or after a failure. Any `GET /api/me` failure there
 * simply means the visitor is anonymous, so an error alert would be pure noise on a page anonymous
 * visitors are expected to reach — and a `role="alert"` would announce that non-event to a screen
 * reader.
 *
 * @param props Identity and Access posture.
 * @returns The identity slot's content, or `null` when there is deliberately nothing to show.
 */
function IdentityStatus({
  identity,
  access
}: {
  identity: IdentityState;
  access: AppHeaderAccess;
}) {
  if (identity.email !== null) {
    // No administrator badge beside the email. The "Admin" nav link above is already sufficient to
    // denote administrative capability, and a second indicator said the same thing twice.
    return <span className="app-shell__identity">{identity.email}</span>;
  }
  if (access === 'public') {
    return null;
  }
  if (identity.loading) {
    return <span className="app-shell__identity">Verifying identity…</span>;
  }
  return (
    <span className="app-shell__identity" role="alert">
      {identity.error}
    </span>
  );
}

/**
 * The sign-in/sign-out slot.
 *
 * On the Access-gated subtree the sign-out link renders unconditionally, including while the
 * identity request is still in flight: a presenter who signs in as the wrong identity must always
 * be able to recover without clearing cookies, and that must not depend on a request having
 * succeeded. It is a real, visible button with an icon rather than a bare text link.
 *
 * A public page has no such requirement and cannot know which control to offer until the identity
 * resolves, so it renders nothing while loading rather than flickering "Sign in" into "Sign out".
 *
 * @param props Identity and Access posture.
 * @returns The sign-in or sign-out control, or `null` while a public page's identity is unresolved.
 */
function AuthAction({ identity, access }: { identity: IdentityState; access: AppHeaderAccess }) {
  if (access === 'public') {
    if (identity.loading) {
      return null;
    }
    if (identity.email === null) {
      return (
        // Points at `/app` rather than a login URL. `/app` is Access-gated, so navigating there
        // *is* the sign-in flow, and Access returns the visitor to the page they asked for
        // afterwards — which a hand-built login link would not.
        <a className="app-shell__logout button" href="/app">
          <LogIn size={16} aria-hidden="true" />
          Sign in
        </a>
      );
    }
  }
  return (
    <a className="app-shell__logout button" href={LOGOUT_PATH}>
      <LogOut size={16} aria-hidden="true" />
      Sign out
    </a>
  );
}
