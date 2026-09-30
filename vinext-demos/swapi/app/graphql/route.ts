import { env } from 'cloudflare:workers';
import application from '../../src/worker';

/**
 * Adapt a Vinext route request to the standalone Hono GraphQL application.
 *
 * This is a delivery-tier adapter and nothing more: it obtains the Worker bindings and forwards the
 * untouched `Request`, so authentication, schema execution, complexity limits, and error masking
 * all stay in `src/worker` rather than leaking into framework routing. It constructs no repository
 * and reads no binding itself — the per-request composition happens in
 * `src/worker/application/request-context.ts`.
 *
 * Unlike the sibling `todo` demo's API adapter, this one sits outside `app/api/` because the path
 * is part of the API's public contract: `/graphql` is the address GraphiQL posts to, the address
 * the explorer's client posts to, and the address a reader bookmarks (UISPEC §11). Moving it to
 * `/api/graphql` to match a folder convention would break all three for no benefit.
 *
 * @param request Incoming GraphQL request, forwarded verbatim.
 * @returns The response produced by the Hono application.
 */
async function handle(request: Request): Promise<Response> {
  return application.fetch(request, env);
}

/**
 * Serve the GraphiQL console.
 *
 * @param request Incoming page request.
 * @returns The GraphiQL document, or an RFC 9457 `401` without a valid Access session.
 */
export const GET = handle;

/**
 * Execute a GraphQL operation.
 *
 * @param request Incoming operation request.
 * @returns A `200` GraphQL response — which may itself carry an `errors` array, as the
 *   specification requires — or an RFC 9457 `401` without a valid Access session.
 */
export const POST = handle;

/**
 * Answer a CORS preflight.
 *
 * Registered because one Yoga handler answers several methods, and omitting this would let the
 * framework reject a preflight before the application saw it.
 *
 * @param request Incoming preflight request.
 * @returns Yoga's preflight response.
 */
export const OPTIONS = handle;
