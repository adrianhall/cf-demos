import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { LinkService } from './application/link-service';
import type { AppBindings } from './bindings';
import { KvLinkRepository } from './infrastructure/kv-link-repository';
import { accessMiddleware } from './middleware/access';
import { linksRouter } from './routes/links';
import { meRouter } from './routes/me';
import { redirectsRouter } from './routes/redirects';

const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

/**
 * Create and attach the request-scoped application service used by every API and redirect route.
 * The composition root is the only location that knows both the Workers KV implementation and the
 * business service, preserving the UI → API → application → infrastructure dependency direction.
 *
 * @param context Hono request context supplying the `LINKS` KV binding.
 * @param next Middleware continuation invoked after the service is attached.
 * @returns A promise fulfilled after downstream middleware and the selected route finish.
 */
app.use(async (context, next) => {
  context.set('LINK_SERVICE', new LinkService(new KvLinkRepository(context.env.LINKS)));
  await next();
});

app.route('/api/links', linksRouter);
app.route('/api/me', meRouter);
app.route('/l', redirectsRouter);

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
