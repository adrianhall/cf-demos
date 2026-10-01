/**
 * @file The application tier's view of model inference. Feature services depend on this interface,
 *   never on `env.AI`. That is what allows every test in this repository to run offline: a suite
 *   injects a fake implementing {@link InferencePort} and exercises the real validation, receipt,
 *   and cost-aggregation logic without a network or an account.
 */

import type { GatewayRequestMetric } from '../../../runs';
import type { TaskId } from '../../../tasks';
import type { ModelDescriptor } from '../../domain/models';

/**
 * The verified caller on whose behalf inference runs.
 *
 * This is a required argument of every inference call rather than an optional context value, and
 * that is a deliberate design constraint rather than bookkeeping. The demo attributes every AI
 * Gateway log to the signed-in user, so a call that could be made without an identity would be a
 * call that could silently produce an unattributable charge. Making the type demand it means the
 * compiler, not a reviewer, enforces the rule.
 *
 * The value always originates from `currentIdentity()` — the Cloudflare Access middleware's
 * verified JWT claims. It must never be assembled from a request header, body, or query parameter.
 */
export interface VerifiedActor {
  /**
   * Verified email address from the Access JWT `email` claim.
   */
  email: string;
  /**
   * Verified subject identifier from the Access JWT `sub` claim.
   */
  sub: string;
}

/**
 * One inference call the application wants to make.
 *
 * @typeParam TInput Model-specific input payload, shaped by the panel's reviewed request schema.
 */
export interface InferenceRequest<TInput = Record<string, unknown>> {
  /**
   * Panel the call belongs to, recorded in gateway metadata so logs can be grouped by panel.
   */
  task: TaskId;
  /**
   * Reviewed descriptor of the model being called.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier, recorded in gateway metadata so the several calls of one user action can
   * be correlated in the dashboard.
   */
  runId: string;
  /**
   * The verified caller; see {@link VerifiedActor}.
   */
  actor: VerifiedActor;
  /**
   * Model input, already validated against the panel's schema.
   */
  input: TInput;
}

/**
 * The outcome of one inference call.
 *
 * @typeParam TOutput Model-specific output payload.
 */
export interface InferenceResult<TOutput = unknown> {
  /**
   * The model's output.
   */
  output: TOutput;
  /**
   * AI Gateway log identifier for the call, when the binding reported one. It is absent rather than
   * empty when the gateway has not yet assigned one, so a caller cannot mistake "no log" for "a log
   * named empty string".
   */
  logId?: string;
  /**
   * Wall-clock duration the client measured, in milliseconds.
   */
  elapsedMs: number;
}

/**
 * The outcome of one streamed inference call.
 *
 * @typeParam TChunk Type each stream increment decodes to.
 */
export interface InferenceStream<TChunk = string> {
  /**
   * The stream increments, in order.
   *
   * An async iterable rather than a callback so the route can `for await` over it and let
   * backpressure and cancellation work the way the runtime intends. A caller that abandons the
   * iteration cancels the underlying stream.
   */
  chunks: AsyncIterable<TChunk>;
  /**
   * Reads the gateway log identifier for the call.
   *
   * A function rather than a value because the identifier is only meaningful once the stream has
   * settled: the binding reports the identifier of its most recent request, so reading it while
   * chunks are still arriving would be reading it before there is anything to read.
   *
   * @returns The log identifier, or `undefined` when the gateway assigned none.
   */
  logId: () => string | undefined;
}

/**
 * The application tier's contract for running a model through AI Gateway.
 *
 * Every implementation routes through the gateway. There is no parameter to turn that off, no
 * "direct" variant, and no fallback: the only way an un-gated call can exist is a documented
 * exception in `src/worker/domain/gateway-exceptions.ts`, which `pnpm check:gateway` verifies.
 */
export interface InferencePort {
  /**
   * Runs one model call through AI Gateway and reports what it cost to run.
   *
   * @typeParam TInput Model-specific input payload.
   * @typeParam TOutput Model-specific output payload.
   * @param request The call to make, including the verified actor; see {@link InferenceRequest}.
   * @returns The model output, the gateway log identifier when one was assigned, and the measured
   *   duration.
   * @throws {ProblemDetailsError} With `502` when the provider or gateway fails, carrying a
   *   sanitised message rather than the provider's own error text.
   * @throws {Error} When the gateway identifier is not configured, which is a deployment fault
   *   rather than a request fault and must not be reported to the caller as a client error.
   */
  run<TInput, TOutput>(request: InferenceRequest<TInput>): Promise<InferenceResult<TOutput>>;

  /**
   * Runs one model call through AI Gateway, streaming its output.
   *
   * Separate from {@link InferencePort.run} rather than a flag on it, because the two have genuinely
   * different shapes: a streamed call has no single return value and its gateway log identifier is
   * not readable until the stream settles. Collapsing them would give every caller an optional
   * stream and an optional result to handle.
   *
   * @typeParam TInput Model-specific input payload. The implementation sets `stream` itself, so a
   *   caller does not have to remember to.
   * @param request The call to make, including the verified actor; see {@link InferenceRequest}.
   * @returns The stream increments and a way to read the gateway log identifier afterwards; see
   *   {@link InferenceStream}.
   * @throws {ProblemDetailsError} With `502` when the provider or gateway fails before streaming
   *   begins, carrying a sanitised message. A failure _during_ the stream surfaces as an error
   *   thrown from the iteration instead, because by then a response has already started.
   * @throws {Error} When the verified actor carries no email, or the gateway is not configured.
   */
  runStream<TInput>(request: InferenceRequest<TInput>): Promise<InferenceStream>;

  /**
   * Reads back the AI Gateway log for a completed call.
   *
   * Separate from {@link InferencePort.run} because the log is written asynchronously: asking for it
   * inline would either block the user's answer or reliably return nothing.
   *
   * @param logId Log identifier previously returned by {@link InferencePort.run}.
   * @returns The normalised metric, or `undefined` when the log has not propagated yet. Absence is
   *   an expected, retryable outcome here, not an error.
   * @throws {Error} When the gateway identifier is not configured.
   */
  readMetric(logId: string): Promise<GatewayRequestMetric | undefined>;
}
