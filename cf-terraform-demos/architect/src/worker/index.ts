import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter, currentIdentityEmail } from '@demos/worker-common';
import { AdminService } from './application/admin-service.ts';
import { DiagramService } from './application/diagram-service.ts';
import { ShareService } from './application/share-service.ts';
import { UserService } from './application/user-service.ts';
import type { AppBindings } from './bindings.ts';
import { isAdministrator } from './domain/user.ts';
import { D1DiagramRepository } from './infrastructure/d1-diagram-repository.ts';
import { D1KvShareRepository } from './infrastructure/d1-kv-share-repository.ts';
import { D1UserRepository } from './infrastructure/d1-user-repository.ts';
import { accessMiddleware } from './middleware/access.ts';
import { recordUserMiddleware } from './middleware/record-user.ts';
import { enforceSameOriginJson } from './middleware/same-origin.ts';
import { createAdminRouter } from './routes/admin.ts';
import { createDiagramsRouter } from './routes/diagrams.ts';
import { createHealthRouter } from './routes/health.ts';
import { createSharesRouter } from './routes/shares.ts';

/**
 * Worker entry point and composition root.
 *
 * Only `/api/*` reaches this Worker in production; every other path is served directly by the
 * `ASSETS` binding with a single-page-application fallback (see `cloudflare.config.ts`). The Access
 * middleware is nonetheless mounted for _all_ paths rather than just `/api/*`, so a request that
 * does arrive here — in local development, in the Workers-runtime test suite, or if asset routing
 * ever changed — is authenticated rather than served by accident.
 *
 * This file is the only place that knows both a concrete adapter and the service built on it, so a
 * route handler always receives a service ready-made and never constructs a repository. That is
 * what keeps the routes → application → domain → infrastructure dependency direction one-way.
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
 * This is the only place in the Worker that knows a concrete adapter at all. A route handler
 * therefore receives a service ready-made, and could not construct a repository even if it tried:
 * nothing under `routes/` imports from `infrastructure/`.
 *
 * The wiring also records two relationships the tiers above deliberately cannot see. The share
 * adapter is the one component spanning both stores — D1 authoritative, KV disposable — and the
 * diagram service holds the share port purely so deleting a diagram revokes every link to it in the
 * same use case, however that delete was reached.
 *
 * @param context Hono request context supplying the `DB` D1 and `SHARES` KV bindings.
 * @param next Middleware continuation invoked after the services are attached.
 * @returns A promise fulfilled after the downstream middleware and selected route finish.
 */
app.use(async (context, next) => {
  const shareRepository = new D1KvShareRepository(context.env.DB, context.env.SHARES);
  const userRepository = new D1UserRepository(context.env.DB);
  const diagramService = new DiagramService(
    new D1DiagramRepository(context.env.DB),
    shareRepository
  );

  context.set('DIAGRAM_SERVICE', diagramService);
  context.set('SHARE_SERVICE', new ShareService(shareRepository, diagramService));
  context.set('USER_SERVICE', new UserService(userRepository));
  // The administrative service is given the same diagram service the owner-scoped routes use,
  // not a second one over the same repository. Moderation deleting a diagram has to leave
  // precisely the state an owner's own delete leaves — including the share cascade — and sharing
  // the use case is what makes that true by construction rather than by review.
  context.set('ADMIN_SERVICE', new AdminService(userRepository, diagramService));
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

app.route('/api/diagrams', createDiagramsRouter());

// Anonymous, read-only, and public by three agreeing decisions — see `./routes/shares.ts`.
app.route('/api/shares', createSharesRouter());

// Administrator-only, and checked here rather than trusted from `/api/me`: the router's own
// middleware re-derives the comparison against `ADMIN_EMAIL` from the verified JWT on every
// request. See `./routes/admin.ts`.
app.route('/api/admin', createAdminRouter());

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
// in a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
