/**
 * Shared Cloudflare Access path policies for local Vite development
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and Worker API validation
 * (`cloudflareAccess` in `src/worker/middleware/access.ts`).
 *
 * Every route on this hostname requires authentication -- no route is anonymous, since inference
 * and stored conversation history are both sensitive and billable (docs/06-AGENTIC-CHAT.md,
 * Functional Requirements). "Admin" is a D1 flag, not a separate Access application or policy
 * (Section 6.5), so this array never branches by path beyond API vs. page navigation.
 */
export const accessPolicies = [
  {
    pattern: /^\/api(?:\/|$)/u,
    authenticate: true,
    redirect: false,
  },
  {
    pattern: /^\//u,
    authenticate: true,
    redirect: true,
  },
];
