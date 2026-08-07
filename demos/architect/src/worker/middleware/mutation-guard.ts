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

/**
 * Enforce the Access Model's same-origin rule for the WebSocket upgrade route specifically.
 *
 * A WebSocket upgrade is always an HTTP `GET` request, so {@link requireSameOriginMutation}'s
 * safe-method bypass would otherwise skip it entirely. `docs/09-ARCHITECT.md`'s Access Model
 * explicitly calls out "same-origin requests for every state-changing API **and WebSocket
 * upgrade**" as a first-class requirement distinct from an ordinary read — joining a live
 * collaboration room is a connecting action, not a passive read. Call this directly from the
 * upgrade route handler (`../routes/diagrams.ts`), never through `app.use()`, since every other
 * `GET` route on `diagramsRouter` must remain origin-agnostic for ordinary same-tab navigation
 * and `fetch()` reads.
 *
 * @param request Raw incoming upgrade request.
 * @throws {ProblemDetailsError} `forbidden()` when `Origin` is missing or does not match the
 * request's own origin.
 */
export function requireSameOriginUpgrade(request: Request): void {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  if (!origin || origin !== requestOrigin) {
    throw forbidden({
      detail: "This WebSocket upgrade must originate from the same origin.",
    });
  }
}
