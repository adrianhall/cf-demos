import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { channelsRouter } from "./routes/channels";
import { roomsRouter } from "./routes/rooms";

// The `CHAT_ROOM` durable_objects binding in `wrangler.jsonc.tpl` requires its class to be a
// named export of this main module.
export { ChatRoom } from "./chat-room/chat-room";

// Only `/api/*` is routed to this Worker (see `wrangler.jsonc.tpl`'s `run_worker_first`); every
// other path is served directly by the `ASSETS` binding's single-page-application fallback.
//
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use("/api/*", accessMiddleware);
app.route("/api", channelsRouter);
app.route("/api/channels", roomsRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
