import type { CloudflareToolkitVariables } from "@adrianhall/cloudflare-toolkit/hono";

/** Request-scoped values supplied by toolkit middleware. */
export type AppVariables = CloudflareToolkitVariables;

/** Hono generic shared by every Worker router and middleware module. */
export interface AppBindings {
  /** Bindings generated from the canonical Wrangler configuration. */
  Bindings: Env;
  /** Values stored on Hono's request context. */
  Variables: AppVariables;
}
