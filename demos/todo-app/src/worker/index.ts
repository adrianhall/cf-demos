import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback.
//
// This is a Phase 1 scaffold: Cloudflare Access enforcement (Phase 2) and the `/api/todos`
// router (Phase 3) are not wired in yet, so every `/api/*` request currently falls through to
// `notFoundHandler`. See docs/02-TODO-APP.md.
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
