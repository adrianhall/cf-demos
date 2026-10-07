import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { currentIdentityEmail, type IdentityEnv } from './identity.ts';

/**
 * A value the endpoint may add to its JSON response. Deliberately narrow: `/api/me` describes the
 * server's view of the caller, and anything richer than a primitive is a sign that a separate
 * endpoint is wanted instead.
 */
export type MeRouterField = string | number | boolean | null;

/**
 * Options for {@link createMeRouter}.
 */
export interface MeRouterOptions<E extends IdentityEnv> {
  /**
   * Extra middleware to run after the Access middleware but before the handler, for an application
   * that narrows which verified identities may read the endpoint.
   */
  middleware?: MiddlewareHandler<E>[];
  /**
   * Derives extra response fields from the verified identity, for an application whose client needs
   * one more server-side answer about the caller than their email — most often whether they are the
   * operator-configured administrator, so the UI can decide what to render without a second round
   * trip and without the browser deciding for itself.
   *
   * The returned fields are merged over nothing: `email` always comes from the verified identity
   * and cannot be overridden, so this can add to the response but never restate or forge its
   * identity.
   *
   * Returning a field here is **not** an authorization decision. A client may read it to choose
   * what to display; every privileged route must still re-check the verified identity itself.
   */
  additionalFields?: (context: Context<E>) => Record<string, MeRouterField>;
}

/**
 * Creates the `/api/me` router, reporting the server's verified view of the caller's identity.
 *
 * Mount it behind the Access middleware:
 *
 * ```ts
 * app.route('/api/me', createMeRouter<AppBindings>());
 * ```
 *
 * Pass extra middleware when the endpoint should admit only some verified identities:
 *
 * ```ts
 * app.route('/api/me', createMeRouter<AppBindings>({ middleware: [requireAdmin] }));
 * ```
 *
 * Pass `additionalFields` when every verified identity may read the endpoint but the client needs
 * one more server-side answer about the caller — the common case being an administrator flag that
 * decides whether an administrative link is rendered at all:
 *
 * ```ts
 * app.route(
 *   '/api/me',
 *   createMeRouter<AppBindings>({
 *     additionalFields: (context) => ({ isAdmin: isAdminIdentity(context) })
 *   })
 * );
 * ```
 *
 * The two options answer different questions and compose. `middleware` decides who may call the
 * endpoint at all; `additionalFields` enriches the answer given to everyone who may.
 *
 * A UI calls this to display who is signed in, and to detect an expired Access session: once the
 * JWT is no longer valid the endpoint answers `401`, provided the matching path policy sets
 * `redirect: false` so a `fetch` receives a status rather than a login page.
 *
 * @typeParam E Hono environment of the application the router is mounted on.
 * @param options Optional extra middleware and response fields; see {@link MeRouterOptions}.
 * @returns A Hono router answering `GET /` with `{ "email": "user@example.com" }`, plus any fields
 *   `additionalFields` contributed.
 */
export function createMeRouter<E extends IdentityEnv>(options: MeRouterOptions<E> = {}): Hono<E> {
  const router = new Hono<E>();

  for (const middleware of options.middleware ?? []) {
    router.use(middleware);
  }

  /**
   * Returns the verified identity's email address, plus any configured additional fields.
   *
   * The identity's `sub` and credential `source` are deliberately never included: they are
   * server-side detail a browser has no use for.
   *
   * @throws {NullError} When the router is mounted without the Access middleware in front of it.
   */
  router.get('/', (context) =>
    context.json({
      ...options.additionalFields?.(context),
      email: currentIdentityEmail(context)
    })
  );

  return router;
}
