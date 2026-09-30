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
 * The standalone Hono application, and the composition root for everything below the framework.
 *
 * Unlike the `cf-terraform-demos/swapi` sibling this is **not** the Worker entrypoint. Vinext owns
 * that (`vinext/server/app-router-entry` in `cloudflare.config.ts`) so it can serve the React
 * explorer, and two Vinext route handlers adapt the non-page surfaces into this application:
 *
 * - `app/api/me/route.ts` → `/api/me`, the verified-identity endpoint the banner reads.
 * - `app/graphql/route.ts` → `/graphql`, the GraphQL endpoint and the GraphiQL console that GraphQL
 *   Yoga generates from inside the Worker.
 *
 * Keeping the API an independent Hono application rather than spreading it across route handlers is
 * what preserves the tier boundary: authentication, GraphQL execution, and error shaping live here,
 * and the framework layer above is thin enough to read in one screen. It is also what lets the
 * Workers-runtime suite in `tests/integration/` point straight at this module and exercise the real
 * authorization paths without a React build.
 *
 * The Access middleware is mounted for _every_ path rather than only the two that are routed here,
 * so a request that reaches this application is authenticated rather than served by accident.
 *
 * The remaining tiers are composed one level down, in `routes/graphql.ts` via
 * `application/request-context.ts`, rather than in this file. That composition must happen _per
 * request_ — the statement counter and the DataLoader caches are both request-scoped — so there is
 * nothing to build once and attach here, as `todo` does with its service. This file keeps what
 * genuinely belongs to the whole application: logging, authentication, routing, and error shaping.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

app.route('/api/me', meRouter);
app.route('/graphql', graphqlRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client. This handles
// failures outside GraphQL execution — an unbound `ACCESS_AUD`, for instance. Errors raised *during*
// execution are shaped by Yoga into the response's `errors` array instead; see `routes/graphql.ts`.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
