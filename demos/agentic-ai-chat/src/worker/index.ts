import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { chatsRouter } from "./routes/chats";
import { meRouter } from "./routes/me";

// The `CHAT_AGENT` durable_objects binding in `wrangler.jsonc.tpl` requires its class to be a
// named export of this main module.
export { ChatAgent } from "./agent/chat-agent";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback, with
// Cloudflare Access itself gating every page at the edge (AGENTS.md, Public Access).
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware);
app.route("/api/me", meRouter);
app.route("/api/chats", chatsRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
