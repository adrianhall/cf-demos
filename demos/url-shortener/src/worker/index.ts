import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { linksRouter } from "./routes/links";
import { meRouter } from "./routes/me";
import { redirectsRouter } from "./routes/redirects";

const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

app.route("/api/links", linksRouter);
app.route("/api/me", meRouter);
app.route("/l", redirectsRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
