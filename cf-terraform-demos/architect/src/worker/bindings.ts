import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { AdminService } from './application/admin-service.ts';
import type { CollaboratorService } from './application/collaborator-service.ts';
import type { DiagramService } from './application/diagram-service.ts';
import type { ShareService } from './application/share-service.ts';
import type { UserService } from './application/user-service.ts';
import type { DiagramSession } from './infrastructure/diagram-session.ts';

/**
 * Hono context variables added by this Worker, on top of the toolkit's `Cloudflare_Access_Identity`
 * and `LOGGER`.
 *
 * The services here are set once by the composition root in `src/worker/index.ts` and read by
 * middleware and route handlers. A handler therefore receives a service ready-made and never
 * constructs a repository of its own, which is what keeps the routes → application → domain →
 * infrastructure dependency direction one-way: nothing in `routes/` imports from
 * `infrastructure/`.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Owner-scoped diagram use cases, backed by the D1 adapter the composition root injected.
   *
   * This service owns every ownership decision the diagram API makes, which is why route handlers
   * receive it rather than a repository: a handler holding a repository could read a row without
   * passing through the rule.
   */
  DIAGRAM_SERVICE: DiagramService;
  /**
   * Sharing use cases, backed by the D1/KV adapter the composition root injected.
   *
   * Read by both postures the sharing feature has: the owner-only routes under `/api/diagrams`, and
   * the anonymous resolver under `/api/shares`. One service serves both because the rule that
   * separates them — an actor is required for management and deliberately absent for resolution —
   * is a business decision rather than a routing one.
   */
  SHARE_SERVICE: ShareService;
  /**
   * Authenticated edit-collaboration use cases, backed by the D1 adapters the composition root
   * injected.
   *
   * It owns both halves of the collaboration rule: the widened "owner or editor" access decision
   * that three diagram routes are held to, and the owner-or-self rule governing who may change the
   * grant list. {@link DiagramService} is given the first of those rather than implementing it, so
   * the two services cannot disagree about who may reach a diagram.
   */
  COLLABORATOR_SERVICE: CollaboratorService;
  /**
   * User-directory use cases, backed by the D1 adapter the composition root injected.
   */
  USER_SERVICE: UserService;
  /**
   * Operator use cases — the user directory and diagram moderation — backed by the same adapters
   * the owner-scoped services use.
   *
   * Set for every request like the rest, rather than only on the administrative routes. Holding the
   * service is not authority to call it: `./middleware/require-admin.ts` is mounted on the
   * administrative router, so no handler elsewhere can reach these use cases regardless of what the
   * context carries.
   */
  ADMIN_SERVICE: AdminService;
}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /**
   * Worker bindings generated from `cloudflare.config.ts` by `cf workers types`, including the `DB`
   * D1 database, the `SHARES` KV namespace and the `DIAGRAM_SESSIONS` Durable Object namespace.
   *
   * `DIAGRAM_SESSIONS` is narrowed to `DurableObjectNamespace<DiagramSession>` here. The generated
   * type is the unparameterised `DurableObjectNamespace`, because `cf`'s inference can only recover
   * the class's methods when the binding names its defining Worker by _config reference_ — and this
   * Worker binds a class it defines itself, so it must name itself by the string in
   * `values.workerName`, which the inference cannot follow back to a module. Restating the type
   * parameter here recovers the typed RPC surface (`notifyGraphUpdated`) that
   * `infrastructure/durable-diagram-sessions.ts` relies on, so a signature change in
   * `DiagramSession` still fails the build at its call site rather than at runtime.
   *
   * `ENVIRONMENT` intentionally does not exist in local development: its absence selects the
   * toolkit's development logging defaults without needing an untracked `.dev.vars` file.
   * Production binds it explicitly as `"production"`.
   */
  Bindings: Omit<Env, 'DIAGRAM_SESSIONS'> & {
    DIAGRAM_SESSIONS: DurableObjectNamespace<DiagramSession>;
    ENVIRONMENT?: string;
  };
  /**
   * Request-scoped application values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
