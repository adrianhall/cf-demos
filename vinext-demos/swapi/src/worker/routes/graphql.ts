import { getOperationAST, type DocumentNode } from 'graphql';
import { createYoga, maskError, type Plugin } from 'graphql-yoga';
import { Hono } from 'hono';
import type { GraphQLContext } from '../application/graphql/context';
import { schema } from '../application/graphql/schema';
import { createRequestContext } from '../application/request-context';
import type { AppBindings } from '../bindings';

/**
 * Per-request state the telemetry plugin fills in and the route logs.
 *
 * Kept separate from {@link GraphQLContext} because it is an API-tier observability concern, not
 * something any resolver should see or be able to influence.
 */
interface RequestTelemetry {
  /**
   * Whether Yoga recognised the request as carrying GraphQL parameters.
   *
   * Distinguishes an executed operation from a request that never became one — a `GET /graphql`
   * serving the GraphiQL page, or a malformed body. Only the former is worth a query log line.
   */
  isOperation: boolean;
  /**
   * Name of the executed operation, or `undefined` for an anonymous one.
   */
  operationName: string | undefined;
}

/**
 * Yoga's server context: the GraphQL context resolvers receive, plus this request's telemetry.
 */
interface ServerContext extends GraphQLContext {
  /**
   * Observability state for the current request.
   */
  telemetry: RequestTelemetry;
}

/**
 * Record the operation name from the parsed document.
 *
 * Taken from the parsed AST rather than from the raw request body, which matters for two reasons:
 * the name is only reliably known after parsing (a document may hold several operations, with the
 * request's `operationName` selecting one), and reading the body again would consume a stream Yoga
 * has already handled.
 *
 * Only the operation _name_ is captured — never the query text or its variables. Query documents
 * routinely embed identifiers, and variables can carry anything; neither belongs in a retained,
 * widely-readable log. The name plus the statement count is enough to identify and cost an
 * operation.
 *
 * @returns A Yoga plugin that writes only to the current request's telemetry object.
 */
function telemetryPlugin(): Plugin<ServerContext, ServerContext> {
  return {
    onParams({ context }) {
      context.telemetry.isOperation = true;
    },
    onParse({ context }) {
      return ({ result }) => {
        if (result instanceof Error || result === null) {
          return;
        }

        context.telemetry.operationName = getOperationAST(
          result as DocumentNode,
          context.params.operationName
        )?.name?.value;
      };
    }
  };
}

/**
 * GraphQL Yoga handler: the executable schema, the GraphiQL console, and telemetry.
 *
 * Built once at module scope because it is stateless. Everything request-scoped arrives through the
 * server context, which the route constructs per request and Yoga passes straight through — the
 * `context` factory here returns it unchanged rather than deriving anything, so there is exactly
 * one place (`../application/request-context.ts`) that decides what a request can reach.
 *
 * `graphiql: true` is unconditional, including in production. That is safe here and deliberate: the
 * console is a static client-side application that can only issue queries the caller was already
 * authorised to issue, the whole hostname sits behind Cloudflare Access, and the schema is
 * read-only. Serving it in production is the point — UISPEC §11 treats it as the explorer's sibling
 * rather than an implementation detail, and the React explorer links to it from both its banner and
 * its empty state.
 *
 * Introspection is likewise left enabled, for the same reasons: GraphiQL's schema explorer and
 * autocompletion depend on it, and there is nothing confidential in the shape of a public Star Wars
 * dataset. An API with a non-public schema or with mutations should reconsider both settings.
 */
const yoga = createYoga<ServerContext, ServerContext>({
  schema,
  // Yoga ships a WHATWG fetch ponyfill for runtimes that lack one, and prefers it unless told
  // otherwise. On Workers that is the wrong choice and fails in a confusing way: Yoga returns a
  // `PonyfillResponse`, the Workers runtime checks the value a `fetch` handler resolves to against
  // its *own* `Response` class, the `instanceof` check fails, and the request dies with
  // `Incorrect type for Promise: the Promise did not resolve to 'Response'` — a message that says
  // nothing about GraphQL. Handing Yoga the runtime's own globals keeps every object it constructs
  // native, so the response passes straight through Hono to the runtime.
  fetchAPI: { fetch, Request, Response, Headers, FormData, ReadableStream, URL, URLSearchParams },
  graphiql: {
    title: 'SWAPI GraphQL',
    // Pre-fill the editor with a query that demonstrates the batched loading this demo is about:
    // three nested levels resolved in a handful of statements. Visible in the console the moment it
    // opens, so the first thing a visitor can do is press play.
    defaultQuery: `# Welcome to the Star Wars GraphQL API.
#
# This query crosses three relations. Check the Worker logs afterwards: the
# whole thing costs a handful of D1 statements, not one per row, because every
# relation is resolved by a single batched query.
{
  films {
    title
    episodeId
    characters(first: 5) {
      name
      homeworld {
        name
        climate
      }
    }
  }
}
`
  },
  graphqlEndpoint: '/graphql',
  context: (serverContext) => serverContext,
  plugins: [telemetryPlugin()],
  // Yoga masks unexpected errors by default; this states it explicitly and ties it to the build
  // mode. An error raised deliberately by the schema (a `GraphQLError`, such as an out-of-range
  // `first` argument) always reaches the caller because it is part of the API's contract. An
  // unexpected one — a D1 failure, a bug — is replaced with a generic message in production so its
  // text cannot leak schema or infrastructure detail, while local development still shows the real
  // cause.
  maskedErrors: {
    maskError: (error, message, isDev) => maskError(error, message, isDev ?? import.meta.env.DEV)
  }
});

/**
 * GraphQL router, mounted at `/graphql` and covering both the endpoint and its console.
 *
 * `all` rather than `get`/`post` because one Yoga handler answers several methods: `GET` serves the
 * GraphiQL document, `POST` executes operations, and `OPTIONS` handles preflight. Routing them
 * separately would mean keeping three registrations in step with whatever Yoga supports.
 */
export const graphqlRouter = new Hono<AppBindings>();

/**
 * Execute a GraphQL request and log one structured record describing what it cost.
 *
 * The statement count is the interesting figure and the reason the context wraps the database at
 * all: it is the evidence that a deeply nested query is resolved in a bounded number of D1 round
 * trips. Logging it next to the duration makes a batching regression visible as a count that grows
 * with the data rather than as a vague slowdown.
 *
 * Requests that never became an operation (the console document itself, for instance) are not
 * logged here — the toolkit's request logger already records those, and a second line adds noise
 * without information.
 *
 * @param context Hono request context providing the `DB` binding and the request logger.
 * @returns Yoga's response: the GraphQL result, or the GraphiQL console for a browser `GET`.
 * @throws {Error} When `DB` is not bound, which means the Worker was built without the D1 binding
 *   from `cloudflare.config.ts`.
 */
graphqlRouter.all('/', async (context) => {
  const startedAt = performance.now();
  const requestContext = createRequestContext(context.env.DB);
  const serverContext: ServerContext = {
    ...requestContext,
    telemetry: { isOperation: false, operationName: undefined }
  };

  const response = await yoga.fetch(context.req.raw, serverContext);

  if (serverContext.telemetry.isOperation) {
    context.get('LOGGER').info('graphql_operation_completed', {
      operationName: serverContext.telemetry.operationName ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      statementCount: requestContext.countStatements()
    });
  }

  return response;
});
