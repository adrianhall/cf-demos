/** Mounts the read-only SWAPI GraphQL API and its always-enabled GraphiQL console. */
import { cloudflareLogger } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import type { AppBindings, AppVariables } from "./bindings";
import {
  createGraphQLServerContext,
  createGraphQLTelemetryPlugin,
  type GraphQLServerContext,
} from "./graphql/observability";
import { schema } from "./graphql/schema";

/** Hono application with GraphQL Yoga mounted as the Worker's sole route. */
const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

app.use(cloudflareLogger());

/** Sends the hostname root to the GraphiQL console without pinning it in browser caches. */
app.get("/", (c) => c.redirect("/graphql", 302));

/** Yoga request handler configured with the executable schema and Worker bindings. */
const yoga = createYoga<GraphQLServerContext, AppBindings>({
  schema,
  graphiql: true,
  graphqlEndpoint: "/graphql",
  context: ({ env }) => env,
  plugins: [createGraphQLTelemetryPlugin()],
});

app.all("/graphql", async (c) => {
  const startedAt = performance.now();
  const context = createGraphQLServerContext(c.env);
  const response = await yoga.fetch(c.req.raw, context);

  if (context.telemetry.isGraphQLRequest) {
    c.get("LOGGER").info("GraphQL request completed", {
      operationName: context.telemetry.operationName ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      statementCount: context.telemetry.statementCount(),
    });
  }

  return response;
});

export default app;
