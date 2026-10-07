import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter, currentIdentityEmail } from '@demos/worker-common';
import { UserService } from './application/user-service.ts';
import type { AppBindings } from './bindings.ts';
import { isAdministrator } from './domain/user.ts';
import { D1UserRepository } from './infrastructure/d1-user-repository.ts';
import { accessMiddleware } from './middleware/access.ts';
import { recordUserMiddleware } from './middleware/record-user.ts';
import { enforceSameOriginJson } from './middleware/same-origin.ts';
import { createAdminRouter } from './routes/admin.ts';
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
 * This file is the only place that knows both a concrete adapter and the service built on it. Later
 * phases add the diagram, share and admin services here the same way, so a route handler always
 * receives a service ready-made and never constructs a repository. That is what keeps the routes →
 * application → domain → infrastructure dependency direction one-way.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());

/**
 * Creates and attaches the request-scoped application services.
 *
 * Mounted before the Access middleware because the middleware that follows it — the user-directory
 * side effect — needs a service to call. Constructing them per request rather than once at module
 * scope is deliberate: a Worker isolate is shared across requests, and a service closed over one
 * request's bindings would outlive the request that created it.
 *
 * @param context Hono request context supplying the `DB` D1 binding.
 * @param next Middleware continuation invoked after the services are attached.
 * @returns A promise fulfilled after the downstream middleware and selected route finish.
 */
app.use(async (context, next) => {
  context.set('USER_SERVICE', new UserService(new D1UserRepository(context.env.DB)));
  await next();
});

app.use(accessMiddleware);
app.use(recordUserMiddleware);

// Mounted for every path rather than per router, so a mutating route added later is covered by
// construction. The middleware is a no-op for a safe method, so a public `GET` is unaffected.
app.use(enforceSameOriginJson);

app.route('/api/health', createHealthRouter());

/**
 * The verified identity, plus whether it is this demo's configured administrator.
 *
 * Every authenticated identity gets a `200` here, including a non-administrator: the client reads
 * `isAdmin` to decide whether to render the administrative link at all, which needs an answer
 * rather than a `403`. That answer is presentational only — every administrative route re-checks
 * the verified identity server-side through `requireAdmin`, so a caller who ignores this field
 * gains nothing.
 */
app.route(
  '/api/me',
  createMeRouter<AppBindings>({
    additionalFields: (context) => ({
      isAdmin: isAdministrator(currentIdentityEmail(context), context.env.ADMIN_EMAIL)
    })
  })
);

app.route('/api/admin', createAdminRouter());

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
// in a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
