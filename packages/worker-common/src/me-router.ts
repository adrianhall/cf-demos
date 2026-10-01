import { Hono, type MiddlewareHandler } from 'hono';
import { currentIdentityEmail, type IdentityEnv } from './identity.ts';

/**
 * Options for {@link createMeRouter}.
 */
export interface MeRouterOptions<E extends IdentityEnv> {
  /**
   * Extra middleware to run after the Access middleware but before the handler, for an application
   * that narrows which verified identities may read the endpoint.
   */
  middleware?: MiddlewareHandler<E>[];
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
 * A UI calls this to display who is signed in, and to detect an expired Access session: once the
 * JWT is no longer valid the endpoint answers `401`, provided the matching path policy sets
 * `redirect: false` so a `fetch` receives a status rather than a login page.
 *
 * @typeParam E Hono environment of the application the router is mounted on.
 * @param options Optional extra middleware; see {@link MeRouterOptions}.
 * @returns A Hono router answering `GET /` with `{ "email": "user@example.com" }`.
 */
export function createMeRouter<E extends IdentityEnv>(options: MeRouterOptions<E> = {}): Hono<E> {
  const router = new Hono<E>();

  for (const middleware of options.middleware ?? []) {
    router.use(middleware);
  }

  /**
   * Returns the verified identity's email address.
   *
   * @throws {NullError} When the router is mounted without the Access middleware in front of it.
   */
  router.get('/', (context) => context.json({ email: currentIdentityEmail(context) }));

  return router;
}
