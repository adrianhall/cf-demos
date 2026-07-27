import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";

// The `CHAT_ROOM` durable_objects binding in `wrangler.jsonc.tpl` requires its class to be a
// named export of this main module.
export { ChatRoom } from "./chat-room/chat-room";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback.
//
// The channel directory (`/api/channels*`) and WebSocket upgrade (`/api/channels/:channel/ws`)
// routers land in Phase 3. Until then, authenticated `/api/*` requests fall through to
// `notFoundHandler`. See docs/04-ENTERPRISE-CHAT.md.
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
