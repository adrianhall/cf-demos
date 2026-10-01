/**
 * @file The one and only place in this application that talks to Workers AI.
 *   `tests/worker/infrastructure/gateway-isolation.test.ts` fails the build if any other production
 *   module references `env.AI.run`, `aiGatewayLogId`, or `env.AI.gateway()`. That guard is the
 *   mechanism behind the demo's central claim: if there is exactly one call site, and that call
 *   site always passes a gateway option, then "every inference request goes through AI Gateway" is
 *   a property of the code rather than a promise in a README.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { GatewayRequestMetric } from '../../../runs';
import { parseSseBuffer } from '../../../sse';
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
  InferenceStream
} from '../../application/ports/inference-port';
import { buildGatewayMetadata } from './gateway-metadata';

/**
 * Header that tells AI Gateway to log metadata but not store request and response payloads.
 *
 * Without it the gateway retains prompts and model output alongside the metrics. This demo needs
 * only the metrics — cost, tokens, cache state, duration — so it opts out of payload storage and
 * can then truthfully tell a visitor that their prompt is not retained.
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
    const options = this.#optionsFor(request);

    const startedAt = Date.now();
    try {
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
    } catch {
      throw this.#providerFailure();
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

    let raw: unknown;
    try {
      raw = await this.#ai.run(request.model.id, input, options);
    } catch {
      throw this.#providerFailure();
    }

    if (!(raw instanceof ReadableStream)) {
      throw this.#providerFailure();
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
   * Builds the sanitised error returned when a provider call fails.
   *
   * The provider's own message is never included. It can contain prompt fragments and internal
   * endpoint names, and neither belongs in a response to a browser.
   *
   * @returns A `502` problem-details error with a message a visitor can act on.
   */
  #providerFailure(): ProblemDetailsError {
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
    } catch {
      return undefined;
    }
  }
}
