import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { requireAdmin } from "./middleware/require-admin";
import { adminRouter } from "./routes/admin";
import { chatsRouter } from "./routes/chats";
import { meRouter } from "./routes/me";
import { transcribeRouter } from "./routes/transcribe";

// The `CHAT_AGENT` durable_objects binding in `wrangler.jsonc.tpl` requires its class to be a
// named export of this main module.
export { ChatAgent } from "./agent/chat-agent";
// `ctx.exports.EgressGateway()` (docs/06-AGENTIC-CHAT.md Phase 10, US-9, Section 6.7) only
// resolves a class that is a top-level export of this script -- `Cloudflare.Exports`, the type
// of `ctx.exports`, is generated from `GlobalProps.mainModule`'s own exports (`wrangler types`).
export { EgressGateway } from "./egress/gateway";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback, with
// Cloudflare Access itself gating every page at the edge (AGENTS.md, Public Access).
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);
app.route("/api/me", meRouter);
app.route("/api/chats", chatsRouter);
app.route("/api/transcribe", transcribeRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
