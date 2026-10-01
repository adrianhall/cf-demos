/**
 * @file The AI Gateway exception register. Routing every inference request through AI Gateway is an
 *   invariant of this demo, not a preference. If a genuine platform limitation ever makes that
 *   impossible for one operation, the exception must be visible in three places that are checked
 *   against each other by `pnpm check:gateway`:
 *
 *   1. a typed entry in {@link GATEWAY_EXCEPTIONS};
 *   2. a `NO_AI_GATEWAY: <id>` comment at the actual call site;
 *   3. a documented section in the demo's root `AI-GATEWAY-EXCEPTIONS.md`. Three places sounds like
 *      ceremony until you consider the alternative: a single ungated `env.AI.run()` without a
 *      gateway option is a one-line change that silently removes cost visibility, caching, and rate
 *      limiting from one panel while every other panel still shows "Routed through AI Gateway". The
 *      checker exists so that change cannot pass review quietly.
 */

/**
 * One documented operation that cannot be routed through AI Gateway.
 */
export interface GatewayException {
  /**
   * Stable identifier, repeated verbatim in the call-site `NO_AI_GATEWAY:` comment and as the
   * heading anchor in `AI-GATEWAY-EXCEPTIONS.md`.
   */
  id: string;
  /**
   * Panel the exception affects.
   */
  panel: string;
  /**
   * API route that performs the un-gated call.
   */
  route: string;
  /**
   * Model or provider and the specific operation that cannot be routed.
   */
  operation: string;
  /**
   * The exact technical reason gateway routing is impossible. "It was easier" is not a reason; a
   * platform limitation with a name is.
   */
  reason: string;
  /**
   * What observability is lost: typically cost, token usage, cache state, and the log ID.
   */
  observabilityLoss: string;
  /**
   * What the person using the panel sees instead, so the UI never claims gateway routing it does
   * not have.
   */
  userFacingBehaviour: string;
  /**
   * Link to the tracked product gap, or an explicit statement that none is warranted.
   */
  tracking: string;
}

/**
 * Every documented exception to the mandatory-gateway rule.
 *
 * Empty, and expected to stay that way. An empty register is the healthy state: it means every
 * inference path in the application is observable and costed. The array exists rather than being
 * omitted so that the checker, the UI badge, and the documentation all have something concrete to
 * read, and so adding the first exception is an obvious, reviewable diff.
 */
export const GATEWAY_EXCEPTIONS: readonly GatewayException[] = [];

/**
 * Looks up a documented exception.
 *
 * @param id Exception identifier, typically taken from a call-site annotation.
 * @returns The matching exception, or `undefined` when the identifier is not registered — which
 *   means an annotation exists for an exception nobody documented.
 */
export function findGatewayException(id: string): GatewayException | undefined {
  return GATEWAY_EXCEPTIONS.find((exception) => exception.id === id);
}
