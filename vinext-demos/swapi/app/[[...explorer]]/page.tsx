import { ExplorerClient } from '../../src/ui/components/explorer-client';

/**
 * Every explorer address — `/`, `/planets`, and `/planets/<id>` — rendered by one page.
 *
 * ## Why one optional catch-all rather than three page files
 *
 * The three columns must **survive navigation**. Selecting a related entity replaces the contents
 * of the collection and detail columns but not the columns themselves (UISPEC §3), and several
 * behaviours depend on that: the collection list keeps its scroll position and filter, focus is
 * moved deliberately to the new heading (§14), and the live region announces a change rather than a
 * fresh page. Splitting these into `app/[type]/page.tsx` and `app/[type]/[id]/page.tsx` would make
 * each navigation a different route segment, so React would unmount and remount the whole explorer
 * and every one of those behaviours would be lost. One segment means one mounted tree that React
 * reconciles in place.
 *
 * A static segment outranks a catch-all, so `app/graphql/route.ts` and `app/api/me/route.ts` are
 * still matched by their own handlers rather than being swallowed by this page.
 *
 * ## Why this renders nothing itself
 *
 * This demo exists to show a **browser** using the GraphQL API, so the data and the explorer itself
 * must not be server-rendered. This server component therefore does no data access at all: it
 * renders `ExplorerClient`, whose dynamic import explicitly sets `ssr: false`, and stops. The
 * interesting consequence is visible in both page source and the network panel — the server emits
 * only the loading shell, then the browser loads the explorer and `POST /graphql` follows from the
 * browser. Server-rendering the first collection (or even the initial application shell) would hide
 * that boundary.
 *
 * @returns The explorer shell.
 */
export default function ExplorerPage(): React.JSX.Element {
  return <ExplorerClient />;
}
