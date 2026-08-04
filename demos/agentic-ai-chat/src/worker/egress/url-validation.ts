/**
 * @file Application-level URL validation for the `getUrl` tool (docs/06-AGENTIC-CHAT.md Phase
 * 10, US-9). This is a **defense-in-depth floor**, not the tool's real enforcement mechanism --
 * AGENTS.md's "Least privilege" requirement is explicit that the `getUrl` tool "must not be
 * able to reach arbitrary internal or unapproved external hosts; enforcement must live in the
 * Dynamic Worker's `globalOutbound` egress gateway, not only in the tool's own application-level
 * URL validation." `EgressGateway`'s allow-list (`./gateway.ts`, `./allowlist.ts`) is what
 * actually decides whether a request reaches the network; this module exists only to reject an
 * obviously-malformed or obviously-internal destination *before* ever spending a Dynamic Worker
 * load and a gateway round trip on it.
 *
 * Like `../files/validation.ts`, this module never throws a `ProblemDetailsError` -- it runs
 * inside a tool's own `execute()` function, with no HTTP response to shape; a rejection here
 * becomes a plain, human-readable tool result the model can explain to the user
 * (`../agent/tools/get-url.ts`), never an unhandled exception that aborts the turn (Section 11).
 *
 * {@link validateUrlFloor} itself is reused as-is by `../skills/source.ts` for a URL-sourced
 * skill's one-time ingestion fetch (docs/06-AGENTIC-CHAT.md Phase 11, US-10) -- the same
 * "http(s) only, no obviously-internal address" floor applies regardless of caller, even though
 * that caller does not also route through `EgressGateway`'s Dynamic Worker sandbox (see
 * `../skills/source.ts`'s own JSDoc for why that mechanism is not needed there).
 */

/**
 * Hostname shapes that are obviously internal/private, checked before ever asking the sandboxed
 * Dynamic Worker to fetch anything. Deliberately conservative pattern matching (not a full
 * CIDR/IP-literal parser) -- this is a floor underneath the gateway's own real enforcement, not
 * a security boundary in its own right, so a false negative here is caught by the allow-list
 * regardless; a false positive would only ever reject a URL this demo's own allow-list was never
 * going to permit anyway.
 */
const PRIVATE_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/** The result of validating one `getUrl` tool-call argument. */
export type UrlValidationResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate one `getUrl` tool-call argument before it is ever handed to the sandboxed Dynamic
 * Worker: it must parse as an absolute URL, its scheme must be `http`/`https` (never
 * `file:`/`data:`/anything else `fetch()` would otherwise attempt), and its hostname must not
 * match an obviously-internal/private shape.
 *
 * @param raw The model's raw `url` tool-call argument.
 * @returns `{ ok: true, url }` with the parsed, normalized URL string, or `{ ok: false, error }`
 * with a human-readable reason the model can relay to the user.
 */
export function validateUrlFloor(raw: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not a valid absolute URL.` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `The URL scheme must be http or https, not "${parsed.protocol.replace(":", "")}".`,
    };
  }

  if (
    PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(parsed.hostname))
  ) {
    return {
      ok: false,
      error: `"${parsed.hostname}" is an internal address and cannot be fetched.`,
    };
  }

  return { ok: true, url: parsed.toString() };
}
