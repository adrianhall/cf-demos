import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import type { AppBindings } from './bindings';
import { accessMiddleware } from './middleware/access';
import { graphqlRouter } from './routes/graphql';
import { meRouter } from './routes/me';

/**
 * Worker entry point and composition root.
 *
 * Two user-facing surfaces share this hostname, and they are served very differently:
 *
 * - **The explorer** (`src/client/`) is a single-page application served from the `ASSETS` binding
 *   with a SPA fallback, so a page load never invokes this Worker at all. Cloudflare Access gates
 *   it at the edge.
 * - **GraphiQL and the GraphQL endpoint** are generated and served by GraphQL Yoga from inside the
 *   Worker, so those requests do run here.
 *
 * `runWorkerFirst` in `cloudflare.config.ts` scopes Worker execution to `/graphql*` and `/api/*`.
 * The Access middleware is nonetheless mounted for _every_ path rather than just those two, so a
 * request that does reach this Worker is authenticated rather than served by accident — including
 * in local development and in the Workers-runtime test suite, where there is no asset routing in
 * front of it.
 *
 * The tiers are composed one level down, in `routes/graphql.ts` via
 * `application/request-context.ts`, rather than in this file. That is because the composition must
 * happen _per request_ — the statement counter and the DataLoader caches are both request-scoped —
 * so there is nothing to build once and attach here, as `todo` does with its service. This file
 * keeps what genuinely belongs to the whole Worker: logging, authentication, routing, and error
 * shaping.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

// `/` no longer redirects to `/graphql`. It now serves the explorer, which is delivered by the
// `ASSETS` binding and so never reaches this router in production. Keeping the old redirect as a
// `302` rather than a `301` is what made this change free: a permanent redirect would still be
// cached by the browser of everyone who had ever visited, and they would never see the explorer.
// GraphiQL remains reachable at its own path, as UISPEC §11 requires.

app.route('/api/me', meRouter);
app.route('/graphql', graphqlRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client. This handles
// failures outside GraphQL execution — an unbound `ACCESS_AUD`, for instance. Errors raised *during*
// execution are shaped by Yoga into the response's `errors` array instead; see `routes/graphql.ts`.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
