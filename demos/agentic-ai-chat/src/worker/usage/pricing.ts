import type { ChatRoute } from "../chats/route";

/** Per-million-token USD rate for one Workers AI model, as published on
 * https://developers.cloudflare.com/workers-ai/platform/pricing/. */
export interface PricingRate {
  readonly promptUsdPerMillionTokens: number;
  readonly completionUsdPerMillionTokens: number;
}

/**
 * The literal Workers AI model id each of this demo's two governed routes currently resolves to
 * (docs/06-AGENTIC-CHAT.md Phase 4, matching `infra/agentic-ai-chat.tf`'s two
 * `cloudflare_ai_gateway_dynamic_routing` model nodes verbatim). This is this demo's own
 * knowledge of the route's *current* configuration, not something read back from AI Gateway --
 * an operator changing a route's model in the dashboard (Section 6.3's whole point) makes this
 * mapping stale for the *estimate* only; the reconciled figure (`../ai-gateway/logs.ts`) is
 * always correct regardless, since it comes from AI Gateway's own logged `model` field.
 */
const MODEL_ID_BY_ROUTE: Record<ChatRoute, string> = {
  basic: "@cf/google/gemma-4-26b-a4b-it",
  reasoning: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
};

/** Verified per-million-token USD rates for the two models {@link MODEL_ID_BY_ROUTE} names,
 * current as of this repo's own verification against the Workers AI pricing page. */
const PRICING_TABLE: Record<string, PricingRate> = {
  "@cf/google/gemma-4-26b-a4b-it": {
    promptUsdPerMillionTokens: 0.1,
    completionUsdPerMillionTokens: 0.3,
  },
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
    promptUsdPerMillionTokens: 0.497,
    completionUsdPerMillionTokens: 4.881,
  },
};

/**
 * The model id `ChatAgent.recordTurnUsage()` should attribute a turn's immediate estimate to,
 * given the chat's governed route selection -- see {@link MODEL_ID_BY_ROUTE}'s own caveat about
 * this being this demo's own snapshot of the route's current configuration, not a live lookup.
 *
 * @param route The chat's selected {@link ChatRoute}.
 * @returns The literal Workers AI model id this route currently resolves to.
 */
export function modelIdForRoute(route: ChatRoute): string {
  return MODEL_ID_BY_ROUTE[route];
}

/**
 * Compute the local, immediately-available USD cost estimate for one completed turn
 * (docs/06-AGENTIC-CHAT.md Section 6.6) -- demoted to an explicitly-labeled fallback the moment
 * `reconcileUsage()` finds AI Gateway's own authoritative figure. An unrecognized model id
 * (never expected for either of this demo's two routes, but defensive against a future model
 * change landing here before this table is updated) estimates `0` rather than throwing, so a
 * pricing-table gap can never itself abort a turn's own persistence.
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
