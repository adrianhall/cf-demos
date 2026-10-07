import type { MiddlewareHandler } from 'hono';
import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import { currentIdentityEmail } from '@demos/worker-common';
import type { AppBindings } from '../bindings.ts';
import { isAdministrator } from '../domain/user.ts';

/**
 * Requires that the Access middleware verified an identity matching the operator-configured
 * `ADMIN_EMAIL`, answering every other identity with an RFC 9457 `403`.
 *
 * The Access middleware alone only proves that _some_ identity from this account's Zero Trust team
 * authenticated, and the authenticated Access application deliberately does not distinguish the
 * administrator — Access answers "who is this", the application answers "what may they do". So
 * every administrative route needs this check of its own rather than relying on the client not
 * asking: `/api/me` reports `isAdmin` to every caller precisely so the UI can decide what to
 * render, and a UI decision is not a gate.
 *
 * Mount it on the administrative router rather than re-deriving it per handler, so a route added to
 * that router is protected by construction instead of by remembering.
 *
 * @throws {ProblemDetailsError} `403` when the verified identity is not the configured
 *   administrator. The detail names the rule rather than the configured address: echoing
 *   `ADMIN_EMAIL` back would disclose the administrator's address to every rejected caller.
 * @throws {NullError} When mounted without the Access middleware in front of it, which is a wiring
 *   mistake rather than a request the caller could have made correctly.
 */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (context, next) => {
  if (!isAdministrator(currentIdentityEmail(context), context.env.ADMIN_EMAIL)) {
    throw forbidden({
      detail: 'This Cloudflare Access identity is not the configured administrator.'
    });
  }

  await next();
};
