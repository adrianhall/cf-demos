'use client';

import dynamic from 'next/dynamic';

/**
 * Load the explorer only in the browser.
 *
 * `ExplorerApp` is a client component already, but that alone does **not** mean "no SSR": an App
 * Router server render can still execute a client component far enough to emit its initial HTML,
 * then hydrate it in the browser. This demo specifically exists to show the browser using the
 * GraphQL API, so the distinction matters. `ssr: false` makes it explicit and testable: the server
 * emits only the stable loading shell below, and the browser imports and mounts the entire
 * explorer. Every catalog request therefore originates in the browser, with no server-rendered copy
 * of the application competing with it.
 *
 * This indirection must itself be a client component. Vinext follows Next's rule that `ssr: false`
 * is not legal in a server component, which is why `app/[[...explorer]]/page.tsx` renders this
 * wrapper instead of calling `dynamic()` directly.
 */
const ClientOnlyExplorer = dynamic(
  () => import('./explorer-app').then((module) => module.ExplorerApp),
  {
    ssr: false,
    loading: () => (
      <main className="client-loading" aria-live="polite">
        <p>Loading SWAPI Explorer…</p>
      </main>
    )
  }
);

/**
 * The explicit client-only boundary for the explorer.
 *
 * @returns The browser-loaded application, or its stable loading shell while the JavaScript chunk
 *   arrives.
 */
export function ExplorerClient(): React.JSX.Element {
  return <ClientOnlyExplorer />;
}
