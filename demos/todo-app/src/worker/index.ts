import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { meRouter } from "./routes/me";
import { todosRouter } from "./routes/todos";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback.
//
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware);
app.route("/api/me", meRouter);
app.route("/api/todos", todosRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
