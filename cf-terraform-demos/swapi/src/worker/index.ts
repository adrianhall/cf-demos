import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import type { AppBindings } from './bindings';
import { accessMiddleware } from './middleware/access';
import { graphqlRouter } from './routes/graphql';

/**
 * Worker entry point and composition root.
 *
 * Unlike the sibling `link` and `todo` demos, every request reaches this Worker: there is no
 * `ASSETS` binding, because the only user interface is the GraphiQL console that GraphQL Yoga
 * generates and serves itself (see `cloudflare.config.ts`). The Access middleware therefore gates
 * real production page loads here, not just API calls — the page policy in `src/access-policies.ts`
 * is genuinely exercised rather than being a local-development convenience.
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

/**
 * Send the hostname root to the GraphiQL console.
 *
 * The console is the whole point of visiting this hostname in a browser, so the root should not be
 * a dead end. `302` rather than `301` deliberately: a permanent redirect would be cached by
 * browsers indefinitely, and `/` is exactly the path the planned data editor will want to claim as
 * its landing page. A temporary redirect can be changed; a permanent one would linger in the
 * browser cache of everyone who had ever visited.
 *
 * @returns A `302` response pointing at `/graphql`.
 */
app.get('/', (context) => context.redirect('/graphql', 302));

app.route('/graphql', graphqlRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client. This handles
// failures outside GraphQL execution — an unbound `ACCESS_AUD`, for instance. Errors raised *during*
// execution are shaped by Yoga into the response's `errors` array instead; see `routes/graphql.ts`.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
