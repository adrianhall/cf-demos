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
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult
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
    const metadata = buildGatewayMetadata(
      request.task,
      request.runId,
      request.actor,
      request.model.contractVersion
    );

    const startedAt = Date.now();
    try {
      const output = (await this.#ai.run(
        request.model.id,
        request.input as Record<string, unknown>,
        {
          gateway: {
            id: this.#gatewayId,
            collectLog: true,
            metadata
          },
          extraHeaders: { [COLLECT_LOG_PAYLOAD_HEADER]: 'false' }
        }
      )) as TOutput;

      return {
        output,
        // Read immediately after the call: the binding exposes the log identifier for the most
        // recent request, so anything awaited in between could overwrite it.
        logId: this.#ai.aiGatewayLogId ?? undefined,
        elapsedMs: Date.now() - startedAt
      };
    } catch {
      throw new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail:
          'The AI provider did not return a usable response. Try again, or choose a different '
          + 'model for this panel.'
      });
    }
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
