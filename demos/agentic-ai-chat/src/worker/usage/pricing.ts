import type { ChatRoute } from "../chats/route";
import type { Business } from "../users/business";

/** Per-million-token USD rate for one Workers AI model, as published on
 * https://developers.cloudflare.com/workers-ai/platform/pricing/. */
export interface PricingRate {
  readonly promptUsdPerMillionTokens: number;
  readonly completionUsdPerMillionTokens: number;
}

/**
 * Which of a route's two business-metadata-gated model nodes a call resolves to
 * (docs/06-AGENTIC-CHAT.md Phase 8, US-7) -- `"field"` is the cheaper tier every route's
 * `business-check` conditional element (`infra/agentic-ai-chat.tf`) sends a `business ===
 * "field"` caller down; `"strong"` is everything else (`"product"`, `"leadership"`, or no
 * business assigned yet), matching the conditional's own `false` branch.
 */
export type BusinessTier = "field" | "strong";

/**
 * Mirror, in application code, which branch AI Gateway's own `business-check` conditional node
 * sends a call down (`infra/agentic-ai-chat.tf`'s `jsonencode({"metadata.business": {"$eq":
 * "field"}})`, Spike B's confirmed conditional syntax) -- **not** a live lookup against AI
 * Gateway, so keep this in sync by hand if that condition ever changes. Used only to pick which
 * model {@link modelIdForRoute} should price the turn's *immediate, local* estimate against
 * before `ChatAgent.reconcileUsage()` can read back AI Gateway's own authoritative figure
 * (Section 6.6) -- a caller with no business assigned yet (`null`) resolves to the same
 * `"strong"` tier as `"product"`/`"leadership"`, exactly like the conditional's own `false`
 * branch treats a missing/non-`"field"` metadata value.
 *
 * @param business The caller's admin-assigned business segment, or `null` if unset.
 * @returns The tier this business segment resolves to on either route.
 */
export function tierForBusiness(business: Business | null): BusinessTier {
  return business === "field" ? "field" : "strong";
}

/**
 * The literal Workers AI model id each of this demo's two governed routes currently resolves a
 * given {@link BusinessTier} to (docs/06-AGENTIC-CHAT.md Phase 4/Phase 8, matching
 * `infra/agentic-ai-chat.tf`'s four `cloudflare_ai_gateway_dynamic_routing` model nodes
 * verbatim). This is this demo's own knowledge of the routes' *current* configuration, not
 * something read back from AI Gateway -- an operator changing a route's model in the dashboard
 * (Section 6.3's whole point) makes this mapping stale for the *estimate* only; the reconciled
 * figure (`../ai-gateway/logs.ts`) is always correct regardless, since it comes from AI
 * Gateway's own logged `model` field.
 */
const MODEL_ID_BY_ROUTE_AND_TIER: Record<
  ChatRoute,
  Record<BusinessTier, string>
> = {
  basic: {
    field: "@cf/google/gemma-4-26b-a4b-it",
    strong: "@cf/zai-org/glm-5.2",
  },
  reasoning: {
    field: "@cf/qwen/qwen2.5-coder-32b-instruct",
    strong: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  },
};

/** Verified per-million-token USD rates for every model {@link MODEL_ID_BY_ROUTE_AND_TIER}
 * names, current as of this repo's own verification against the Workers AI pricing page. */
const PRICING_TABLE: Record<string, PricingRate> = {
  "@cf/google/gemma-4-26b-a4b-it": {
    promptUsdPerMillionTokens: 0.1,
    completionUsdPerMillionTokens: 0.3,
  },
  "@cf/zai-org/glm-5.2": {
    promptUsdPerMillionTokens: 1.4,
    completionUsdPerMillionTokens: 4.4,
  },
  "@cf/qwen/qwen2.5-coder-32b-instruct": {
    promptUsdPerMillionTokens: 0.66,
    completionUsdPerMillionTokens: 1.0,
  },
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
    promptUsdPerMillionTokens: 0.497,
    completionUsdPerMillionTokens: 4.881,
  },
};

/**
 * The model id `ChatAgent.recordTurnUsage()` should attribute a turn's immediate estimate to,
 * given the chat's governed route selection and the caller's business segment (Phase 8, US-7)
 * -- see {@link MODEL_ID_BY_ROUTE_AND_TIER}'s own caveat about this being this demo's own
 * snapshot of the routes' current configuration, not a live lookup.
 *
 * @param route The chat's selected {@link ChatRoute}.
 * @param business The caller's admin-assigned business segment, or `null` if unset --
 * {@link tierForBusiness} resolves this to the tier AI Gateway's own conditional node would.
 * @returns The literal Workers AI model id this route/business combination currently resolves
 * to.
 */
export function modelIdForRoute(
  route: ChatRoute,
  business: Business | null,
): string {
  return MODEL_ID_BY_ROUTE_AND_TIER[route][tierForBusiness(business)];
}

/**
 * Compute the local, immediately-available USD cost estimate for one completed turn
 * (docs/06-AGENTIC-CHAT.md Section 6.6) -- demoted to an explicitly-labeled fallback the moment
 * `reconcileUsage()` finds AI Gateway's own authoritative figure. An unrecognized model id
 * (never expected for any of this demo's four route/tier combinations, but defensive against a
 * future model change landing here before this table is updated) estimates `0` rather than
 * throwing, so a pricing-table gap can never itself abort a turn's own persistence.
 *
 * @param modelId The literal model id to price against (see {@link modelIdForRoute}).
 * @param promptTokens This turn's prompt (input) token count.
 * @param completionTokens This turn's completion (output) token count.
 * @returns The estimated USD cost, or `0` for an unrecognized model id.
 */
export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = PRICING_TABLE[modelId];
  if (!rate) {
    return 0;
  }
  return (
    (promptTokens * rate.promptUsdPerMillionTokens +
      completionTokens * rate.completionUsdPerMillionTokens) /
    1_000_000
  );
}
