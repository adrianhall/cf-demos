import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { ChatService } from './application/chat-service';
import type { ChatRoom } from './infrastructure/chat-room';

/**
 * Hono context variables added by this Worker: the toolkit's `Cloudflare_Access_Identity` and
 * `LOGGER`, plus the request-scoped {@link ChatService} that routes use instead of constructing
 * their own repository or reaching for a Durable Object namespace.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Application tier for the shared chat workspace, wired in `src/worker/index.ts`.
   */
  CHAT_SERVICE: ChatService;
}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /**
   * Worker bindings generated from `cloudflare.config.ts` by `cf workers types`, including the `DB`
   * D1 database and the `CHAT_ROOM` Durable Object namespace.
   *
   * `CHAT_ROOM` is narrowed to `DurableObjectNamespace<ChatRoom>` here. The generated type is the
   * unparameterised `DurableObjectNamespace`, because `cf`'s inference can only recover the class's
   * methods when the binding names its defining Worker by _config reference_ — and this Worker
   * binds a class it defines itself, so it must name itself by the string in `values.workerName`,
   * which the inference cannot follow back to a module. Restating the type parameter here recovers
   * the typed RPC surface (`join`, `destroy`) that `infrastructure/durable-chat-rooms.ts` relies
   * on, so a signature change in `ChatRoom` still fails the build at every call site rather than at
   * runtime.
   *
   * `ENVIRONMENT` intentionally does not exist in local development: its absence selects the
   * toolkit's development logging defaults without needing an untracked `.dev.vars` file.
   * Production binds it explicitly as `"production"`.
   */
  Bindings: Omit<Env, 'CHAT_ROOM'> & {
    CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
    ENVIRONMENT?: string;
  };
  /**
   * Request-scoped application values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
