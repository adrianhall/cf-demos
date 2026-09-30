import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';

/**
 * Build a `426 Upgrade Required` RFC 9457 error.
 *
 * The toolkit ships a named generator for every status it has needed so far, but not `426` — it is
 * only meaningful to an application that speaks a second protocol on an HTTP endpoint, which this
 * demo does and the others do not. Constructing it through `ProblemDetailsError` keeps the response
 * shape identical to every other error this Worker returns, so a client parses one format rather
 * than two.
 *
 * `426` is the right status for a plain `GET` to the socket route, rather than `400`: the request
 * is well-formed and the resource exists, but it can only be used over a different protocol. `400`
 * would tell a caller to fix their request without saying what is wrong with it.
 *
 * @param detail User-safe explanation of what the endpoint expected.
 * @returns A `426`-status `ProblemDetailsError` ready to `throw`.
 */
export function upgradeRequired(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({ status: 426, detail });
}
