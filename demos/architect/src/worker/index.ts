import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { ArchitectureWorkflow } from "./architecture-workflow";
import type { AppBindings } from "./bindings";
import { DiagramRoom } from "./diagram-room";
import { accessMiddleware } from "./middleware/access";
import { meRouter } from "./routes/me";

const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);
app.route("/api/me", meRouter);
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export { ArchitectureWorkflow, DiagramRoom };
export default app;
