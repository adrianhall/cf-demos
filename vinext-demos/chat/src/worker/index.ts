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
 * The API application and its composition root.
 *
 * Unlike the sibling Vue demo, this Worker is not the platform entrypoint. Vinext's App Router
 * handler owns every incoming request (re-exported by `src/worker-entry.ts`, see
 * `cloudflare.config.ts`), and the `app/api/**` route handlers forward the ones they own into this
 * application with `application.fetch(request, env)`. Keeping the whole API as a standalone Hono
 * app means routing, authorization, validation, and domain logic are independent of the framework
 * in front of them: the same application is exercised directly by the Workers-runtime tests in
 * `tests/integration/`.
 *
 * The `ChatRoom` class is deliberately **not** re-exported here. A Durable Object namespace is
 * declared by a named class export on the _Worker's entry module_, and that module is
 * `src/worker-entry.ts` rather than this one — Vinext owns the entrypoint. Exporting it from here
 * as well would suggest this file is the platform entry, which it is not.
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
