import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '@demos/worker-common';
import type { AppBindings } from './bindings';
import { accessMiddleware } from './middleware/access';
import { catalogueRouter } from './routes/catalogue';

/**
 * Worker entry point and composition root.
 *
 * This file is allowed to depend on every server-side tier — routes, middleware, application,
 * domain, and infrastructure — because composing them is its single responsibility. No other module
 * gets that privilege: a route handler that constructs an inference client would be reaching across
 * the boundary this file exists to hold.
 *
 * Only `/api/*` reaches this Worker in production; every other path is served directly by the
 * `ASSETS` binding with a single-page-application fallback (see `cloudflare.config.ts`). The Access
 * middleware is nonetheless mounted for _all_ paths rather than just `/api/*`, so a request that
 * does arrive here — in local development, in the Workers-runtime test suite, or if asset routing
 * ever changed — is authenticated rather than served by accident.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

app.route('/api/me', createMeRouter<AppBindings>());
app.route('/api/catalogue', catalogueRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
