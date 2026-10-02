/**
 * @file The one and only place in this application that talks to Workers AI.
 *   `tests/worker/infrastructure/gateway-isolation.test.ts` fails the build if any other production
 *   module references `env.AI.run`, `aiGatewayLogId`, or `env.AI.gateway()`. That guard is the
 *   mechanism behind the demo's central claim: if there is exactly one call site, and that call
 *   site always passes a gateway option, then "every inference request goes through AI Gateway" is
 *   a property of the code rather than a promise in a README.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { GatewayRequestMetric } from '../../../shared/runs';
import { parseSseBuffer } from '../../../shared/sse';
import type { DiagnosticLogger } from '../../application/ports/diagnostic-logger-port';
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
  InferenceStream
} from '../../application/ports/inference-port';
import { isInsufficientGatewayCredit } from '../../domain/provider-failures';
import { buildGatewayMetadata } from './gateway-metadata';

/**
 * Header asking AI Gateway to log metadata without storing request and response payloads.
 *
 * This demo needs only the metrics — cost, tokens, cache state, duration — so it opts out of
 * payload storage as a matter of good practice.
 *
 * It is deliberately **not** the basis of a privacy promise to the visitor, and the UI makes no
 * such promise. Three reasons: payload retention is AI Gateway's behaviour rather than this
 * application's to guarantee; `GatewayOptions` on the AI binding exposes no payload-collection
 * field, so this travels as `extraHeaders` and the application cannot confirm it was honoured; and
 * the gateway's own documentation states that a log can include the prompt and response. The panels
 * therefore tell a visitor to assume their prompt is logged, which is a claim that stays true
 * whatever the platform does.
 */
const COLLECT_LOG_PAYLOAD_HEADER = 'cf-aig-collect-log-payload';

/**
 * Marker Workers AI sends as the final SSE frame of a text-generation stream.
 *
 * It is the OpenAI streaming convention: a literal `[DONE]` rather than JSON. Parsing it as JSON
 * would throw at the very end of every successful stream.
 */
const STREAM_DONE_MARKER = '[DONE]';

/**
 * Extracts the generated text from one streamed frame's JSON payload.
 *
 * Workers AI text-generation models send `{"response":"..."}` per frame, but the catalog also
 * carries OpenAI-compatible shapes, so `choices[0].delta.content` is accepted as well. Anything
 * unrecognised yields `undefined` rather than throwing: a single malformed or novel frame should
 * cost one increment of text, not the whole answer the visitor is already reading.
 *
 * @param data The frame's `data` field.
 * @returns The text increment, or `undefined` when the frame carried none.
 */
function extractStreamedText(data: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record['response'] === 'string') {
    return record['response'];
  }

  const choices = record['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.['delta'] as Record<string, unknown> | undefined;
    if (typeof delta?.['content'] === 'string') {
      return delta['content'];
    }
  }

  return undefined;
}

/**
 * Input fields whose _values_ are safe to log.
 *
 * An allowlist, not a denylist. Every entry here is a numeric or boolean control a visitor chose
 * from a bounded range, which is exactly what is needed to reproduce a failed attempt — and nothing
 * here is the visitor's content. A denylist would eventually leak a field somebody added later.
 */
const LOGGABLE_PARAMETER_VALUES: readonly string[] = [
  'steps',
  'num_steps',
  'width',
  'height',
  'guidance',
  'seed',
  'strength',
  'temperature',
  'max_tokens',
  'top_p',
  'top_k',
  'stream',
  'raw'
];

/**
 * Summarises a model input for a structured log.
 *
 * Reports two things: the full list of parameter _names_ sent, and the values of those on the
 * allowlist. The name list is what catches the most common integration failure — sending a model a
 * parameter its schema does not accept — because it shows what actually went on the wire rather
 * than what the code intended.
 *
 * Text and binary fields are reduced to their length. A prompt is the visitor's content and does
 * not belong in a Worker log, but knowing it was 48 characters rather than empty is often the
 * difference between a quick diagnosis and a long one.
 *
 * @param input The model input that was sent.
 * @returns Structured fields describing the request's shape.
 */
function describeParameters(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) {
    return { inputShape: typeof input };
  }

  const record = input as Record<string, unknown>;
  const parameters: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (LOGGABLE_PARAMETER_VALUES.includes(key)) {
      parameters[key] = value;
    } else if (typeof value === 'string') {
      parameters[`${key}Length`] = value.length;
    } else if (Array.isArray(value)) {
      parameters[`${key}Count`] = value.length;
    }
  }

  return {
    // The exact keys sent, in order. A model that rejects an undeclared parameter is diagnosed
    // immediately from this line.
    parameterNames: Object.keys(record),
    parameters
  };
}

/**
 * Dependencies required to talk to Workers AI through the configured gateway.
 */
export interface GatewayInferenceClientOptions {
  /**
   * The Workers AI binding.
   */
  ai: Ai;
  /**
   * Identifier of the AI Gateway every request must travel through, from the `AI_GATEWAY_ID`
   * binding that Terraform's output populates.
   */
  gatewayId: string;
  /**
   * Where provider failures are recorded.
   *
   * Supplied by the composition root. The client logs the provider's own message here and returns a
   * sanitised one to the caller, which is the only arrangement that satisfies both requirements at
   * once: a visitor must not see a provider's internals, and an operator must not be left
   * guessing.
   *
   * Optional so a unit test can omit it, but the composition root always passes one.
   */
  logger?: DiagnosticLogger;
}

/**
 * Extracts a loggable description from an unknown thrown value.
 *
 * Workers AI throws `Error` subclasses whose `message` carries the provider's actual complaint —
 * "input must be an object", a model-specific validation failure, a capacity error. That text is
 * the single most useful thing when a panel fails, and discarding it was why a `502` from this
 * client used to be undiagnosable.
 *
 * @param cause The thrown value.
 * @returns Name, message, and stack where available, ready to put in a structured log.
 */
function describeCause(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    return {
      errorName: cause.name,
      errorMessage: cause.message,
      // A provider error frequently wraps another. Reading one level down is usually where the
      // actionable detail is. A non-Error cause is JSON-encoded rather than coerced with `String`,
      // which would render an object as the useless `[object Object]`.
      ...(cause.cause === undefined ? {} : { errorCause: describeUnknown(cause.cause) })
    };
  }

  return { errorName: 'NonError', errorMessage: describeUnknown(cause) };
}

/**
 * Renders an unknown thrown value as readable text.
 *
 * `String(value)` on an object produces `[object Object]`, which occupies a log line while saying
 * nothing. JSON encoding keeps the detail; a value that cannot be encoded — a circular structure —
 * falls back to its type so the line still records that something was thrown.
 *
 * @param value The value to describe.
 * @returns A readable description.
 */
function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return `[unserialisable ${value.constructor.name}]`;
    }
  }

  return typeof value === 'string' ? value : (JSON.stringify(value) ?? typeof value);
}

/**
 * Runs Workers AI and catalog models through this demo's AI Gateway.
 *
 * Construct it once per request in the Worker's composition root and inject it into application
 * services as an {@link InferencePort}. Nothing above the infrastructure tier should know this class
 * exists.
 */
export class GatewayInferenceClient implements InferencePort {
  readonly #ai: Ai;
  readonly #gatewayId: string;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates a client bound to one gateway.
   *
   * @param options The Workers AI binding and the gateway identifier; see
   *   {@link GatewayInferenceClientOptions}.
   * @throws {Error} When the gateway identifier is missing or blank. This fails at construction
   *   rather than at the first inference call on purpose: an un-configured gateway is a broken
   *   deployment, and the failure should be loud and immediate instead of surfacing later as a
   *   request that quietly reached a provider with no observability.
   */
  constructor(options: GatewayInferenceClientOptions) {
    if (options.gatewayId.trim() === '') {
      throw new Error(
        'AI_GATEWAY_ID is not bound. Run `pnpm deploy:infra` so Terraform publishes the gateway '
          + 'identifier, or restore infra/local-outputs.json for local development.'
      );
    }

    this.#ai = options.ai;
    this.#gatewayId = options.gatewayId;
    this.#logger = options.logger;
  }

  /**
   * Runs one model call through AI Gateway.
   *
   * The gateway options are assembled here and nowhere else, so there is no code path that can
   * produce a call without them. `collectLog` is always `true` because the whole cost story depends
   * on a log existing to read back.
   *
   * @typeParam TInput Model-specific input payload.
   * @typeParam TOutput Model-specific output payload.
   * @param request The call to make, including the verified actor; see {@link InferenceRequest}.
   * @returns The model output, the gateway log identifier when one was assigned, and the measured
   *   duration.
   * @throws {Error} When the verified actor carries no email, so the request could not be
   *   attributed.
   * @throws {ProblemDetailsError} With `502` when the provider or gateway fails. The provider's own
   *   message is deliberately discarded: it can contain prompt fragments and internal endpoint
   *   details, neither of which belongs in a response to a browser.
   */
  async run<TInput, TOutput>(request: InferenceRequest<TInput>): Promise<InferenceResult<TOutput>> {
    if (request.actor.email.trim() === '') {
      throw new Error('Inference requires a verified user email for attribution.');
    }

    const startedAt = Date.now();
    try {
      if (request.model.remixImageControls?.inputAdapter === 'flux-multipart') {
        // NO_AI_GATEWAY: flux-2-workers-ai-multipart-stream
        // The binding requires a multipart ReadableStream and AI Gateway rejects that shape before
        // inference. This exact operation is registered and documented; no other model reaches this
        // direct call. It intentionally has no Gateway log ID or Gateway-derived cost.
        const output = (await this.#ai.run(
          request.model.id,
          request.input as Record<string, unknown>
        )) as TOutput;
        return { output, elapsedMs: Date.now() - startedAt };
      }

      const options = this.#optionsFor(request);
      const output = (await this.#ai.run(
        request.model.id,
        request.input as Record<string, unknown>,
        options
      )) as TOutput;

      return {
        output,
        // Read immediately after the call: the binding exposes the log identifier for the most
        // recent request, so anything awaited in between could overwrite it.
        logId: this.#ai.aiGatewayLogId ?? undefined,
        elapsedMs: Date.now() - startedAt
      };
    } catch (cause) {
      throw this.#providerFailure(request, cause, Date.now() - startedAt);
    }
  }

  /**
   * Runs one model call through AI Gateway and streams its output.
   *
   * Workers AI returns a `ReadableStream` of server-sent events when the input asks for streaming.
   * This decodes those frames and yields the generated text, so the application tier deals in text
   * increments and never in the provider's streaming envelope.
   *
   * `stream: true` is set here rather than trusted from the caller's input, which means there is no
   * way to call this method and accidentally receive a non-streamed response — the mismatch that
   * would otherwise surface as an empty answer.
   *
   * @typeParam TInput Model-specific input payload.
   * @param request The call to make, including the verified actor; see {@link InferenceRequest}.
   * @returns The text increments and a reader for the gateway log identifier; see
   *   {@link InferenceStream}.
   * @throws {Error} When the verified actor carries no email.
   * @throws {ProblemDetailsError} With `502` when the provider fails before streaming starts, or
   *   when it answers with something other than a stream despite being asked for one.
   */
  async runStream<TInput>(request: InferenceRequest<TInput>): Promise<InferenceStream> {
    const options = this.#optionsFor(request);
    const input = { ...(request.input as Record<string, unknown>), stream: true };

    const startedAt = Date.now();
    let raw: unknown;
    try {
      raw = await this.#ai.run(request.model.id, input, options);
    } catch (cause) {
      throw this.#providerFailure(request, cause, Date.now() - startedAt);
    }

    if (!(raw instanceof ReadableStream)) {
      // Asking for a stream and receiving something else is a contract mismatch, so it is reported
      // as one rather than as a generic provider error — the distinction matters when a model's
      // output shape changes under us.
      throw this.#providerFailure(
        request,
        new Error(`Expected a stream but the provider returned ${typeof raw}.`),
        Date.now() - startedAt
      );
    }

    // Captured before the first chunk is read and resolved after the last. `aiGatewayLogId` always
    // describes the binding's most recent request, so a later call from another request in the same
    // isolate would overwrite it; reading it as the stream ends is the last moment it is still ours.
    let settledLogId: string | undefined;
    const ai = this.#ai;

    return {
      chunks: (async function* decode(): AsyncGenerator<string> {
        const reader = (raw as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            // `stream: true` on the decoder, so a chunk boundary falling inside a multi-byte
            // character is held over rather than emitted as a replacement character.
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;

            for (const frame of parsed.frames) {
              if (frame.data === STREAM_DONE_MARKER) {
                continue;
              }

              const text = extractStreamedText(frame.data);
              if (text !== undefined && text !== '') {
                yield text;
              }
            }
          }
        } finally {
          // Runs on normal completion and on abandonment alike, so a cancelled request releases
          // the upstream stream instead of leaving it open for the isolate's lifetime.
          reader.releaseLock();
          settledLogId = ai.aiGatewayLogId ?? undefined;
        }
      })(),
      logId: () => settledLogId
    };
  }

  /**
   * Builds the gateway options for one request.
   *
   * Both call paths go through this, so neither can exist without the gateway, the log collection,
   * or the metadata. That is what makes the mandatory-gateway rule a property of the code: there is
   * no second place where options are assembled and one could be left out.
   *
   * @typeParam TInput Model-specific input payload.
   * @param request The call being made.
   * @returns The options object to pass to the Workers AI binding.
   * @throws {Error} When the verified actor carries no email, so the request could not be
   *   attributed.
   */
  #optionsFor<TInput>(request: InferenceRequest<TInput>): {
    gateway: { id: string; collectLog: boolean; metadata: Record<string, string | number> };
    extraHeaders: Record<string, string>;
  } {
    return {
      gateway: {
        id: this.#gatewayId,
        collectLog: true,
        metadata: buildGatewayMetadata(
          request.task,
          request.runId,
          request.actor,
          request.model.contractVersion
        )
      },
      extraHeaders: { [COLLECT_LOG_PAYLOAD_HEADER]: 'false' }
    };
  }

  /**
   * Logs a provider failure in full and returns the sanitised error to raise.
   *
   * These two jobs are deliberately in one function, because doing only one of them is the bug this
   * replaced. The provider's own message cannot go to the browser — it can carry prompt fragments
   * and internal endpoint names — but discarding it entirely left a `502` with nothing behind it,
   * and no way to tell which request had failed or why.
   *
   * The log records the shape of the request rather than its content: the model, the panel, the run
   * identifier, which parameters were sent and what they were set to. Those are the fields that
   * identify _which_ attempt failed and make a provider's complaint actionable. The prompt text and
   * the verified email are both excluded — the email belongs in AI Gateway metadata only, and the
   * prompt is the visitor's content.
   *
   * @typeParam TInput Model-specific input payload.
   * @param request The call that failed.
   * @param cause The value the binding threw.
   * @param elapsedMs How long the attempt took before failing.
   * @returns A `502` problem-details error with a message a visitor can act on.
   */
  #providerFailure<TInput>(
    request: InferenceRequest<TInput>,
    cause: unknown,
    elapsedMs: number
  ): ProblemDetailsError {
    this.#logger?.error('inference_provider_failed', {
      task: request.task,
      model: request.model.id,
      runId: request.runId,
      gatewayId: this.#gatewayId,
      contractVersion: request.model.contractVersion,
      elapsedMs,
      // The gateway may have assigned a log before failing. When it did, this is the thread that
      // ties the Worker log to the AI Gateway dashboard entry; when it did not, its absence is
      // itself the finding — the request never reached the gateway.
      gatewayLogId: this.#ai.aiGatewayLogId ?? null,
      ...describeParameters(request.input),
      ...describeCause(cause)
    });

    // Unified Catalog models are paid from prepaid AI Gateway credits. This gateway error contains
    // no visitor content and has one actionable resolution, so preserve the category while still
    // withholding every provider detail. Treat it as unavailable capacity (`503`), not a malformed
    // upstream response (`502`): retrying the same request cannot work until the account is topped up.
    if (isInsufficientGatewayCredit(cause)) {
      // Logged separately from `inference_provider_failed` so the *decision* is recorded, not just
      // the failure. A caller further out classifies by reading this error's status, so knowing
      // which status this method chose is what makes that chain verifiable end to end.
      this.#logger?.error('inference_billing_failure', {
        task: request.task,
        runId: request.runId,
        model: request.model.id,
        sanitisedStatus: 503
      });

      return new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail:
          'This model uses prepaid AI Gateway credits, and this account does not have enough '
          + 'credit for the request. Add AI Gateway credits, then try again.'
      });
    }

    return new ProblemDetailsError({
      status: 502,
      title: 'The model could not complete this request',
      detail:
        'The AI provider did not return a usable response. Try again, or choose a different '
        + 'model for this panel.'
    });
  }

  /**
   * Reads back one AI Gateway log and normalises it.
   *
   * @param logId Log identifier previously returned by {@link GatewayInferenceClient.run}.
   * @returns The normalised metric, or `undefined` when the log has not propagated yet. A missing
   *   log is a routine, retryable outcome rather than an error, so it is not thrown: the gateway
   *   writes its record asynchronously and a lookup moments after the response commonly misses.
   */
  async readMetric(logId: string): Promise<GatewayRequestMetric | undefined> {
    try {
      const log = await this.#ai.gateway(this.#gatewayId).getLog(logId);
      return {
        logId: log.id,
        model: log.model,
        provider: log.provider,
        cached: log.cached,
        success: log.success,
        durationMs: log.duration,
        costUsd: log.cost,
        tokensIn: log.tokens_in,
        tokensOut: log.tokens_out
      };
    } catch (cause) {
      // A log that has not propagated yet is the common case and is not an error, so this stays at
      // `warn` and still returns `undefined` for the caller to retry. The cause is recorded anyway:
      // an unpropagated log and a genuinely broken `getLog` call are indistinguishable from the
      // return value alone, and a run stuck permanently at "cost pending" is diagnosed from here.
      this.#logger?.warn('gateway_log_unavailable', {
        logId,
        gatewayId: this.#gatewayId,
        ...describeCause(cause)
      });
      return undefined;
    }
  }
}
