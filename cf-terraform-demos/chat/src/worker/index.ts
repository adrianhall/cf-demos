import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { ChatService } from './application/chat-service';
import type { AppBindings } from './bindings';
import { D1ChannelRepository } from './infrastructure/d1-channel-repository';
import { DurableChatRooms } from './infrastructure/durable-chat-rooms';
import { accessMiddleware } from './middleware/access';
import { channelsRouter } from './routes/channels';
import { meRouter } from './routes/me';

/**
 * The `CHAT_ROOM` Durable Object class, re-exported from the Worker's entry module.
 *
 * The export is not decorative: `exports.durableObject('ChatRoom')` in `cloudflare.config.ts`
 * declares a namespace backed by a class of exactly this name on this module, and a deploy fails if
 * the runtime cannot find it. Keeping the re-export next to the composition root also makes the
 * Worker's full public surface visible in one file — a default `fetch` handler and one Durable
 * Object class.
 */
export { ChatRoom } from './infrastructure/chat-room';

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
 * This is the only location in the Worker that knows both concrete storage technologies — D1 for
 * the channel directory, Durable Objects for each channel's conversation — and the business service
 * that uses them. Routes receive the service ready-made and never construct a repository or touch a
 * Durable Object namespace, which is what keeps the UI → API → application → infrastructure
 * dependency direction one-way: nothing in `routes/` imports from `infrastructure/`.
 *
 * That the two stores are composed here, side by side, is the clearest statement of this demo's
 * architecture: the split between a relational directory and per-channel coordination objects is an
 * infrastructure decision, made once, in one place, and invisible above this line.
 *
 * @param context Hono request context supplying the `DB` and `CHAT_ROOM` bindings.
 * @param next Middleware continuation invoked after the service is attached.
 * @returns A promise fulfilled after the downstream middleware and selected route finish.
 */
app.use(async (context, next) => {
  context.set(
    'CHAT_SERVICE',
    new ChatService(
      new D1ChannelRepository(context.env.DB),
      new DurableChatRooms(context.env.CHAT_ROOM)
    )
  );
  await next();
});

app.route('/api/me', meRouter);
app.route('/api/channels', channelsRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
// in a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
