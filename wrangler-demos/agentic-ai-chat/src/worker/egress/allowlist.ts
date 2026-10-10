/**
 * @file The `getUrl` tool's egress allow-list (docs/06-AGENTIC-CHAT.md Phase 10, US-9, Section
 * 6.7). `EgressGateway` (`./gateway.ts`) is the only code that consults this list -- the actual
 * "deny by default, permit deliberately" enforcement happens there, at the platform layer
 * (Dynamic Workers' `globalOutbound`), never only in the tool's own application-level URL
 * validation (`../agent/tools/get-url.ts`'s `validateUrlFloor()`), per AGENTS.md's
 * "Least privilege" requirement.
 *
 * A spike-quality hard-coded `Set` was good enough for Spike C's own throwaway proof
 * (`spikes/02-dynamic-workers-egress-control/src/egress-gateway.ts`); this demo's real list is
 * committed here, in its own module, so `DEMO.md` and `EXPLAIN-DEMO.md` can point at one file
 * rather than an inline literal buried in the gateway class.
 */

/**
 * Hostnames the sandboxed `getUrl` tool may reach. Deliberately small and real: every entry is
 * a stable, always-reachable Cloudflare-owned property, so a presenter can demonstrate both the
 * allowed and blocked paths against genuinely live URLs (`DEMO.md`) without depending on a
 * third party's uptime.
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "developers.cloudflare.com",
  "blog.cloudflare.com",
]);

/**
 * Whether `hostname` may be fetched by the `getUrl` tool's sandboxed Dynamic Worker.
 *
 * @param hostname A request URL's `hostname` (from `new URL(url).hostname`), never a full URL.
 * @returns `true` only for an exact, case-sensitive match in {@link ALLOWED_HOSTS} -- no
 * wildcard/subdomain matching, so this list is always an exhaustive, at-a-glance statement of
 * exactly what this demo can reach.
 */
export function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.has(hostname);
}
