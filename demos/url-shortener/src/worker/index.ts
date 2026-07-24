import {
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { loggerMiddleware } from "./middleware/logger";
import { linksRouter } from "./routes/links";
import { redirectsRouter } from "./routes/redirects";

const app = new Hono<AppBindings>();

app.use(loggerMiddleware);
app.use(accessMiddleware);

app.route("/api/links", linksRouter);
app.route("/l", redirectsRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
