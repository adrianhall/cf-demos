/** Mounts the read-only SWAPI GraphQL API and its always-enabled GraphiQL console. */
import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import type { AppBindings } from "./bindings";
import { schema } from "./graphql/schema";

/** Hono application with GraphQL Yoga mounted as the Worker's sole route. */
const app = new Hono<{ Bindings: AppBindings }>();

/** Yoga request handler configured with the executable schema and Worker bindings. */
const yoga = createYoga<{ env: AppBindings }>({
  schema,
  graphiql: true,
  graphqlEndpoint: "/graphql",
  context: ({ env }) => env,
});

app.mount("/graphql", yoga, {
  replaceRequest: (request) => request,
});

export default app;
