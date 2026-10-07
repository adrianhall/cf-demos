import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, getStoredTheme } from './lib/theme.ts';
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
