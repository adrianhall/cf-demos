import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { TodoService } from './application/todo-service';
import type { AppBindings } from './bindings';
import { D1TodoRepository } from './infrastructure/d1-todo-repository';
import { accessMiddleware } from './middleware/access';
import { meRouter } from './routes/me';
import { todosRouter } from './routes/todos';

/**
 * The API application and its composition root.
 *
 * Unlike the sibling Vue demo, this Worker is not the platform entrypoint. Vinext's
 * `vinext/server/app-router-entry` owns every incoming request (see `cloudflare.config.ts`), and
 * the `app/api/**` route handlers forward the ones they own into this application with
 * `application.fetch(request, env)`. Keeping the whole API as a standalone Hono app means routing,
 * authorization, validation, and domain logic are independent of the framework in front of them:
 * the same application is exercised directly by the Workers-runtime tests in `tests/integration/`.
 *
 * The Access middleware is mounted for _all_ paths rather than just `/api/*`. Only API paths are
 * routed here today, but a fail-closed default means a path that is forwarded in future is
 * authenticated by default rather than by remembering to add it.
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

app.route('/api/me', meRouter);
app.route('/api/todos', todosRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
