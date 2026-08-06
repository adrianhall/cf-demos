/**
 * Worker bindings consumed by the data-access layer.
 *
 * This derives from Wrangler's generated `Env` type so binding definitions are
 * never duplicated in authored source.
 */
export type AppBindings = Pick<Env, "DB">;

/** Hono variables supplied by cross-cutting Worker middleware. */
export type AppVariables =
  import("@adrianhall/cloudflare-toolkit/hono").LoggerVariables;
