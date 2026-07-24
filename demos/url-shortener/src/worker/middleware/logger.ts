import {
  createLogger,
  type LogLevel,
  resolveLoggerConfig,
} from "@adrianhall/cloudflare-toolkit/logging";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings";

/** Every level the toolkit's `Logger` accepts, in ascending severity order. */
const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

/**
 * Default severity per Worker `ENVIRONMENT` when the operator has not set an explicit
 * `LOG_LEVEL` override. The toolkit's own `resolveLoggerConfig` defaults production to
 * `"warn"`, which would silence this demo's informational `short_link_used` event (see
 * `routes/redirects.ts`) in the Workers Logs the presentation flow relies on — so this
 * Worker keeps its own, slightly more verbose, per-environment defaults instead.
 */
const DEFAULT_LEVEL_BY_ENVIRONMENT: Readonly<Record<string, LogLevel>> = {
  development: "debug",
  production: "info",
  test: "trace",
};

/** Narrow an operator-supplied `LOG_LEVEL` value, ignoring anything unrecognized. */
function isLogLevel(value: string | undefined): value is LogLevel {
  return (
    value !== undefined && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the minimum log severity for the current request: the explicit `LOG_LEVEL`
 * Worker variable when it is set to a recognized level, otherwise a per-`ENVIRONMENT`
 * default (falling back to `"info"` for an unrecognized or missing `ENVIRONMENT`).
 *
 * Exported (rather than kept module-private) solely so `logger.test.ts` can exercise this
 * pure decision table directly, without constructing a Hono `Context` for every branch.
 *
 * @param env Worker bindings for the current request.
 * @returns The resolved minimum severity to emit.
 */
export function resolveLevel(env: Env): LogLevel {
  if (isLogLevel(env.LOG_LEVEL)) {
    return env.LOG_LEVEL;
  }
  return DEFAULT_LEVEL_BY_ENVIRONMENT[env.ENVIRONMENT] ?? "info";
}

/**
 * Request-scoped structured logger middleware. Behaves like the toolkit's
 * `cloudflareLogger()` — same `resolveLoggerConfig`-driven transport selection (console
 * for `development`, structured for `production`, capture for `test`), same one-`Logger`-
 * per-request construction — but built from `/logging`'s framework-agnostic primitives
 * directly instead of calling `cloudflareLogger()` itself. `cloudflareLogger()`'s return
 * type is a `MiddlewareHandler` scoped to its own narrow `{ Variables: LoggerVariables }`
 * environment, which Hono's `Context` typing cannot widen back to this Worker's
 * {@link AppBindings} without an unsafe cast; calling `createLogger`/`resolveLoggerConfig`
 * here instead keeps this middleware's `Context` type exact with no cast required. The
 * only behavioral difference is severity: an explicit `LOG_LEVEL` Worker variable wins,
 * otherwise `ENVIRONMENT` picks a default (see {@link resolveLevel}) instead of
 * `resolveLoggerConfig`'s own `"warn"`-in-production default.
 */
export const loggerMiddleware: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const { transport } = resolveLoggerConfig(context.env.ENVIRONMENT, "worker");
  context.set(
    "LOGGER",
    createLogger({ level: resolveLevel(context.env), transport }),
  );
  await next();
};
