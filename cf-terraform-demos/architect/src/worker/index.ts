import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '@demos/worker-common';
import type { AppBindings } from './bindings.ts';
import { accessMiddleware } from './middleware/access.ts';
import { createHealthRouter } from './routes/health.ts';

/**
 * Worker entry point and composition root.
 *
 * Only `/api/*` reaches this Worker in production; every other path is served directly by the
 * `ASSETS` binding with a single-page-application fallback (see `cloudflare.config.ts`). The Access
 * middleware is nonetheless mounted for _all_ paths rather than just `/api/*`, so a request that
 * does arrive here — in local development, in the Workers-runtime test suite, or if asset routing
 * ever changed — is authenticated rather than served by accident.
 *
 * This file is the only place that will know both a concrete adapter and the service built on it.
 * Later phases construct the D1 and KV adapters here and attach the resulting application services
 * to the request context, so a route handler receives a service ready-made and never constructs a
 * repository. That is what keeps the routes → application → domain → infrastructure dependency
 * direction one-way.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

app.route('/api/health', createHealthRouter());
app.route('/api/me', createMeRouter<AppBindings>());

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
// in a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
