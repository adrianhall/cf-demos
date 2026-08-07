import {
  forbidden,
  unsupportedMediaType,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Enforce the Access Model's "every state-changing API" rule: reject a missing or foreign
 * `Origin` and require an exact JSON content type before a mutating request's body is read.
 *
 * Safe methods (`GET`, `HEAD`) are never state-changing and pass through unchecked — a page
 * navigation or `fetch("/api/diagrams")` read has no `Origin` requirement here. Mount this on
 * every router that accepts `POST`/`PATCH`/`DELETE` diagram requests, after `accessMiddleware`.
 *
 * WebSocket upgrades are a separate, Phase 4 concern (`docs/09-ARCHITECT.md`'s Access Model);
 * this middleware only ever sees ordinary HTTP request/response pairs.
 */
export const requireSameOriginMutation: MiddlewareHandler = async (
  context,
  next,
) => {
  if (SAFE_METHODS.has(context.req.method)) {
    await next();
    return;
  }

  const origin = context.req.header("origin");
  const requestOrigin = new URL(context.req.url).origin;
  if (!origin || origin !== requestOrigin) {
    throw forbidden({
      detail: "This request must originate from the same origin.",
    });
  }

  const contentType = context.req.header("content-type");
  if (!contentType?.startsWith("application/json")) {
    throw unsupportedMediaType({
      detail: "Mutations must use the application/json content type.",
    });
  }

  await next();
};
