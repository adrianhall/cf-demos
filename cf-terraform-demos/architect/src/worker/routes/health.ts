import { Hono } from 'hono';
import type { AppBindings } from '../bindings.ts';

/**
 * Shape returned by `GET /api/health`.
 */
export interface HealthResponse {
  /**
   * Always `"ok"`. A constant rather than a computed value: this endpoint reports that the Worker
   * is routing requests, not that any downstream resource is reachable.
   */
  status: 'ok';
}

/**
 * Liveness router mounted at `/api/health`.
 *
 * Deliberately public (see the matching entry in `src/access-policies.ts` and the omission from the
 * authenticated Access application's destinations in `infra/access.tf`): a probe that needs a
 * verified identity cannot answer "is the deployment serving traffic?" when the thing that is
 * broken is authentication itself.
 *
 * It reports no version, no binding state and no environment name. Those would each be a small
 * disclosure to an anonymous caller in exchange for information an operator can already read from
 * observability, and this phase's purpose for the route is only to prove the Worker builds, routes,
 * and shapes responses before any product feature exists.
 *
 * @returns A Hono router answering `GET /` with {@link HealthResponse}.
 */
export function createHealthRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.get('/', (context) => context.json<HealthResponse>({ status: 'ok' }));

  return router;
}
