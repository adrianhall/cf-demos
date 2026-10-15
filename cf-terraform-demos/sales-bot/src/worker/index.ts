import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { IdentityService } from './application/identity-service';
import type { AppBindings } from './bindings';
import { D1IdentityRepository } from './infrastructure/d1-identity-repository';
import { accessMiddleware } from './middleware/access';
import { meRouter } from './routes/me';

/**
 * SalesBot Worker composition root.
 *
 * It wires D1 into the application service once, leaving routes responsible only for HTTP shaping.
 */
const app = new Hono<AppBindings>();
app.use(cloudflareLogger());
app.get('/health', (context) => context.json({ status: 'ok' }));
app.use(accessMiddleware);
app.use(async (context, next) => {
  context.set('IDENTITY_SERVICE', new IdentityService(new D1IdentityRepository(context.env.DB)));
  await next();
});
app.route('/api/me', meRouter);
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
