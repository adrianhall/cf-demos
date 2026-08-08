import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { App } from "./App";

/**
 * Start the browser application: mounts the React app to `#root`.
 *
 * Cloudflare Access gates the authenticated `/app*` subtree at the edge before the document
 * request reaches this script (see AGENTS.md's Public Access section), so no client-side
 * authentication redirect is needed here.
 */
export function startClient(): void {
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
