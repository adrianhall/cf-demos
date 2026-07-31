import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { chatRouter } from "./routes/chat";
import { meRouter } from "./routes/me";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback,
// which Cloudflare Access also gates at the edge before the request ever reaches this Worker.
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

app.route("/api/me", meRouter);
app.route("/api/chat", chatRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
