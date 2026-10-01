import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';

/**
 * Builds a `426 Upgrade Required` RFC 9457 error.
 *
 * Use it on a route that only serves a non-HTTP protocol, to answer a request that did not ask to
 * switch:
 *
 * ```ts
 * if (context.req.header('Upgrade') !== 'websocket') {
 *   throw upgradeRequired('This endpoint accepts WebSocket connections only.');
 * }
 * ```
 *
 * @param detail User-safe explanation of the protocol the endpoint expected.
 * @returns A `426`-status `ProblemDetailsError` ready to `throw`.
 */
export function upgradeRequired(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({ status: 426, detail });
}
