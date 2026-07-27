import type { CloudflareToolkitVariables } from "@adrianhall/cloudflare-toolkit/hono";

/** Request-scoped values supplied by Cloudflare toolkit middleware. */
export type AppVariables = CloudflareToolkitVariables;

/** Hono typing shared by Worker routers and middleware. */
export interface AppBindings {
  /** Wrangler-generated Cloudflare bindings. */
  Bindings: Env;
  /** Middleware-provided request values. */
  Variables: AppVariables;
}
