/**
 * @file The application tier's view of model inference. Every service depends on this interface and
 *   never on `env.AI`. That is what lets every test in this demo run offline — a suite injects a
 *   fake and exercises the real decision, citation, and escalation logic without a network or an
 *   account — and it is also what makes the mandatory-gateway rule checkable: there is exactly one
 *   implementation, `../infrastructure/gateway-inference-client.ts`, and
 *   `tests/worker/gateway-isolation.test.ts` fails the build if any other module touches the
 *   binding.
 */

import type { ModelDescriptor } from './models';

/**
 * The verified caller a model call is made on behalf of.
 *
 * A required argument of every call rather than an optional context value, and that is a design
 * constraint rather than bookkeeping: every AI Gateway log is attributed to the signed-in identity,
 * so a call that could be made without one would be a call that produces an unattributable charge.
 * Making the type demand it means the compiler enforces the rule.
 *
 * The value always originates from the Access middleware's verified identity, never from a request
 * header, body, or frame.
 */
export interface VerifiedActor {
  /**
   * Verified email from the Access JWT `email` claim.
   */
  email: string;
  /**
   * Stable identity key resolved from D1 for that email.
   */
  identityKey: string;
}

/**
 * One inference call the application wants to make.
 */
export interface InferenceRequest {
  /**
   * Reviewed descriptor of the model to call.
   */
  model: ModelDescriptor;
  /**
   * System instruction establishing the model's task and its grounding constraints.
   */
  system: string;
  /**
   * The user-role content: the question and, for the answer model, the bounded evidence.
   */
  prompt: string;
  /**
   * Conversation the call belongs to, recorded in gateway metadata so the calls of one conversation
   * can be grouped in the dashboard.
   */
  conversationId: string;
  /**
   * Correlation identifier, recorded in gateway metadata so a Worker log line and a gateway log
   * entry can be tied together.
   */
  correlationId: string;
  /**
   * The verified caller; see {@link VerifiedActor}.
   */
  actor: VerifiedActor;
  /**
   * Signal that abandons the call when the requester cancels or disconnects.
   *
   * Threaded through rather than ignored because an abandoned generation is still a charge: a
   * salesperson who closes the tab should stop costing money, and a cancelled answer must not be
   * persisted after the requester said they no longer wanted it.
   */
  signal?: AbortSignal;
}

/**
 * The outcome of one inference call.
 */
export interface InferenceResult {
  /**
   * The model's generated text.
   */
  text: string;
  /**
   * AI Gateway log identifier, when the gateway assigned one. Absent rather than empty when it did
   * not, so a caller cannot mistake "no log" for "a log named empty string".
   */
  logId?: string;
  /**
   * Wall-clock duration measured by the client, in milliseconds.
   */
  elapsedMs: number;
}

/**
 * The application tier's contract for running a model through AI Gateway.
 *
 * Every implementation routes through the gateway. There is no parameter to turn that off, no
 * "direct" variant, and no fallback — the specification's fixed decision that all Workers AI calls
 * go through AI Gateway is expressed as the absence of any other option.
 */
export interface InferencePort {
  /**
   * Run one model call through AI Gateway.
   *
   * @param request The call to make, including the verified actor and reviewed model.
   * @returns The generated text, the gateway log identifier when one was assigned, and the measured
   *   duration.
   * @throws {ProblemDetailsError} `502` when the provider or gateway fails, carrying a sanitized
   *   message rather than the provider's own error text; `499`-equivalent cancellation surfaces as
   *   an `AbortError` instead.
   * @throws {Error} When the gateway identifier is not configured, which is a broken deployment
   *   rather than a request fault and must not be reported to a caller as a client error.
   */
  generate(request: InferenceRequest): Promise<InferenceResult>;
}
