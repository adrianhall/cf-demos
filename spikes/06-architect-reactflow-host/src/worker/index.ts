import {
  cloudflareAccess,
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
  type CloudflareToolkitVariables,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { accessPolicies } from "../access-policies";

/**
 * Hono variables this spike's Worker sets — just the toolkit's logging + Access identity, no
 * demo-specific state.
 */
type AppVariables = CloudflareToolkitVariables;

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use(cloudflareLogger());
app.use(
  cloudflareAccess({
    policies: accessPolicies,
    // Fail-closed outside local development, matching every other demo in this repository.
    enableDevTokens: import.meta.env.DEV,
  }),
);

/**
 * Proves `cloudflareAccess()` reaches a real Hono route mounted under `/api/*` in this host,
 * exactly like `demos/url-shortener`'s `GET /api/me` — the smallest possible confirmation that
 * an authenticated API call behaves the same in this plain Vite/React setup as it would in any
 * other demo here.
 */
app.get("/api/whoami", (c) => {
  const identity = c.get("Cloudflare_Access_Identity");
  c.get("LOGGER").info("whoami requested", { email: identity.email });
  return c.json({ email: identity.email });
});

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
