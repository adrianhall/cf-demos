import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, getStoredTheme } from './lib/theme.ts';
// React Flow's own stylesheet, imported *before* `./app.css` so this application's rules — which
// deliberately override several `.react-flow__*` selectors for stacking and pointer behaviour —
// come after it and win.
//
// Not optional decoration: React Flow positions every node absolutely from this stylesheet, so
// without it a canvas lays its nodes out in normal document flow and a diagram renders as a
// vertical list of boxes. It is imported here, at the entry point, rather than beside the first
// component that happens to need it, because both the thumbnails on this phase's gallery and
// dashboard and the editor in a later phase depend on it, and a per-component import would make
// the page's styling depend on which component mounted first.
import '@xyflow/react/dist/style.css';
import './app.css';

/**
 * Starts the browser application: applies a stored colour-scheme preference, if any, then mounts
 * the React app to `#root`.
 *
 * The theme is applied here, before the first render, rather than in a separate inline `<script>`
 * in `index.html`. This SPA has no server-rendered markup to flash an unstyled version of in the
 * first place — nothing is visible in `#root` until this same module runs — so there is no
 * flash-of-wrong-theme window that a blocking inline script would close and this ordering would
 * not.
 *
 * Cloudflare Access gates the authenticated `/app*` subtree at the edge before the document request
 * reaches this script, so there is no client-side authentication redirect here.
 *
 * @returns Nothing. The React root is mounted as a side effect.
 * @throws {Error} When `index.html` has no `#root` element to mount into, which means the document
 *   and this entry point have gone out of sync.
 */
export function startClient(): void {
  const storedTheme = getStoredTheme();
  if (storedTheme) {
    applyTheme(storedTheme);
  }

  const container = document.getElementById('root');
  if (!container) {
    throw new Error('#root element not found');
  }

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

startClient();
