import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { upsertUserMiddleware } from "./middleware/upsert-user";
import { adminRouter } from "./routes/admin";
import { diagramsRouter } from "./routes/diagrams";
import { mcpRouter } from "./routes/mcp";
import { meRouter } from "./routes/me";
import { sharesRouter } from "./routes/shares";

// The `DIAGRAM_SESSIONS` durable_objects binding in `wrangler.jsonc.tpl` requires its class to
// be a named export of this Worker's main module (mirroring `demos/chat`'s `ChatRoom`).
export { DiagramSession } from "./diagram-session/diagram-session";

// `/api/*` and `/mcp*` are routed to this Worker (see `wrangler.jsonc.tpl`'s
// `run_worker_first`); every other path -- the public landing page and the authenticated `/app*`
// shell alike -- is served directly by the `ASSETS` binding's single-page-application fallback,
// gated (or not) by Cloudflare Access at the edge before the request ever reaches this Worker.
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware, upsertUserMiddleware);
app.use("/mcp", accessMiddleware, upsertUserMiddleware);

app.route("/api/me", meRouter);
app.route("/api/diagrams", diagramsRouter);
app.route("/api/share", sharesRouter);
app.route("/api/admin", adminRouter);
app.route("/mcp", mcpRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
