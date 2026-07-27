import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { libraryRouter } from "./routes/library";
import { studioRouter } from "./routes/studio";

const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);
app.route("/api/library", libraryRouter);
app.route("/api/studio", studioRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
