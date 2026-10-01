import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '@demos/worker-common';
import { TodoService } from './application/todo-service';
import type { AppBindings } from './bindings';
import { D1TodoRepository } from './infrastructure/d1-todo-repository';
import { accessMiddleware } from './middleware/access';
import { todosRouter } from './routes/todos';

/**
 * Worker entry point and composition root.
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

/**
 * Create and attach the request-scoped application service used by every API route.
 *
 * This is the only location in the Worker that knows both the concrete D1 implementation and the
 * business service. Routes receive the service ready-made and never construct a repository, which
 * is what keeps the UI → API → application → infrastructure dependency direction one-way: nothing
 * in `routes/` imports from `infrastructure/`.
 *
 * @param context Hono request context supplying the `DB` D1 binding.
 * @param next Middleware continuation invoked after the service is attached.
 * @returns A promise fulfilled after the downstream middleware and selected route finish.
 */
app.use(async (context, next) => {
  context.set('TODO_SERVICE', new TodoService(new D1TodoRepository(context.env.DB)));
  await next();
});

app.route('/api/me', createMeRouter<AppBindings>());
app.route('/api/todos', todosRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
