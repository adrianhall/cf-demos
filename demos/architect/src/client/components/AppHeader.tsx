import { LogIn, LogOut } from "react-feather";
import type { IdentityState } from "../hooks/useIdentity";
import { DarkModeToggle } from "./DarkModeToggle";

/**
 * Which page is rendering the header. Used only to omit the nav link that would point at the
 * page the visitor is already on.
 */
export type AppHeaderPage = "dashboard" | "admin" | "blueprints";

/**
 * Whether the page rendering the header sits behind Cloudflare Access.
 *
 * - `authenticated`: the Access-gated `/app*` subtree. A verified identity is guaranteed by the
 *   edge before this bundle ever runs, so a failed `GET /api/me` is a real fault worth surfacing,
 *   and the sign-out control is rendered unconditionally.
 * - `public`: `/blueprints`, covered by the hostname-wide public `bypass` Access application
 *   (`infra/access.tf`, docs/09-ARCHITECT.md's Access Model). The visitor may legitimately be
 *   anonymous, so a failed identity request means "not signed in", not "something broke".
 */
export type AppHeaderAccess = "authenticated" | "public";

/** Props for {@link AppHeader}. */
export interface AppHeaderProps {
  /**
   * Identity resolved by the *calling view*, not by this component. `AppShellView` already needs
   * `isAdmin` to gate the admin route, so calling `useIdentity()` here as well would fire a
   * second, redundant `GET /api/me` on every `/app/admin` render. Taking it as a prop also keeps
   * this component purely presentational and directly unit-testable without stubbing `fetch`.
   */
  identity: IdentityState;
  /** Page rendering the header. */
  current: AppHeaderPage;
  /** Access posture of the page rendering the header. */
  access: AppHeaderAccess;
}

/**
 * The single application banner, shared by every "chrome" page: the authenticated dashboard and
 * admin views (via `../views/AppShellView.tsx`) and the public blueprint gallery (via
 * `../views/BlueprintsView.tsx`).
 *
 * GitLab issue #2 (docs/09-ARCHITECT.md's Reported Issues, Bug 34): `BlueprintsView` previously
 * rendered its own ad-hoc header whose brand and "My Diagrams" links were plain underlined,
 * link-coloured anchors in the wrong font weight, because only `.app-shell__name` ever opted out
 * of the browser's default anchor styling. Consolidating both headers here means there is one
 * banner implementation to keep consistent.
 *
 * The editor route deliberately renders no banner at all (Bug 23) -- see `AppShellView`.
 */
export function AppHeader({ identity, current, access }: AppHeaderProps) {
  const signedIn = identity.email !== null;

  // On the Access-gated subtree the visitor is authenticated by definition, so the brand always
  // goes to the diagram list -- including while `GET /api/me` is still in flight, where
  // `signedIn` is briefly false but the identity is not actually in doubt. On the public
  // gallery an anonymous visitor gets the home page instead, so clicking the logo can never
  // bounce them into an Access login they did not ask for.
  const brandHref = access === "authenticated" || signedIn ? "/app" : "/";

  // Suppressed on the dashboard itself, where this would link to the current page and the view
  // already carries a "My Diagrams" <h1> (`./dashboard/DiagramGrid.tsx`).
  const showDashboardLink = current !== "dashboard";

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
      {identity.isAdmin && (
        <a className="app-shell__nav-link nav-link" href="/app/admin">
          Admin
        </a>
      )}
      <IdentityStatus identity={identity} access={access} />
      <DarkModeToggle />
      <AuthAction identity={identity} access={access} />
    </header>
  );
}

/**
 * The identity slot: the verified email, or -- on the Access-gated subtree only -- the loading
 * and error states of the identity request.
 *
 * A public page renders nothing at all while loading or after a failure. Any `GET /api/me`
 * failure there simply means the visitor is anonymous (the endpoint requires Access;
 * `../access-policies.ts`), so an error alert would be pure noise on a page anonymous visitors
 * are expected to reach.
 */
function IdentityStatus({
  identity,
  access,
}: {
  identity: IdentityState;
  access: AppHeaderAccess;
}) {
  if (identity.email !== null) {
    // Bug 27 (docs/09-ARCHITECT.md Phase 9): the Bug 5 shield icon next to the email is removed
    // -- the "Admin" nav link above is already sufficient to denote admin capabilities, so a
    // second, redundant admin indicator next to the email is not needed.
    return <span className="app-shell__identity">{identity.email}</span>;
  }
  if (access === "public") {
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
 * On the Access-gated subtree the sign-out link is rendered unconditionally, including while the
 * identity request is still in flight, per AGENTS.md's Public Access section: a presenter who
 * signs in as the wrong identity locally must always be able to recover without clearing
 * cookies. A real, visible `.button` with an icon (Bug 1, docs/09-ARCHITECT.md Phase 7) rather
 * than a bare text link.
 *
 * A public page has no such requirement and cannot know which control to offer until the
 * identity resolves, so it renders nothing while loading rather than flickering "Sign in" into
 * "Sign out".
 */
function AuthAction({
  identity,
  access,
}: {
  identity: IdentityState;
  access: AppHeaderAccess;
}) {
  if (access === "public") {
    if (identity.loading) {
      return null;
    }
    if (identity.email === null) {
      return (
        <a className="app-shell__logout button" href="/app">
          <LogIn size={16} aria-hidden="true" />
          Sign in
        </a>
      );
    }
  }
  return (
    <a className="app-shell__logout button" href="/cdn-cgi/access/logout">
      <LogOut size={16} aria-hidden="true" />
      Sign out
    </a>
  );
}
