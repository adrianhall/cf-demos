import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./lib/theme";

/**
 * Start the browser application: applies a stored dark-mode preference (if any -- see
 * `./lib/theme.ts`, docs/09-ARCHITECT.md Phase 5) and mounts the React app to `#root`.
 *
 * The theme is applied here, before the first render, rather than a separate inline `<script>`
 * in `index.html`: this SPA has no server-rendered markup to flash an unstyled version of in the
 * first place (nothing is visible in `#root` until this same module runs), so there is no
 * flash-of-wrong-theme window a blocking inline script would need to close that this ordering
 * doesn't already close.
 *
 * Cloudflare Access gates the authenticated `/app*` subtree at the edge before the document
 * request reaches this script (see AGENTS.md's Public Access section), so no client-side
 * authentication redirect is needed here.
 */
export function startClient(): void {
  const storedTheme = getStoredTheme();
  if (storedTheme) {
    applyTheme(storedTheme);
  }

  const container = document.getElementById("root");
  if (!container) {
    throw new Error("#root element not found");
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

startClient();
