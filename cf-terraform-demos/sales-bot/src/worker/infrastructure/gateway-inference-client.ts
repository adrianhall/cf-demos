/**
 * @file The one and only place in this application that talks to Workers AI.
 *   `tests/worker/gateway-isolation.test.ts` fails the build if any other module references the
 *   `AI` binding, `aiGatewayLogId`, or `env.AI.gateway()`. That guard is the mechanism behind the
 *   specification's fixed decision that _all_ Workers AI calls go through AI Gateway with no direct
 *   fallback: if there is exactly one call site, and that call site always passes a gateway option,
 *   then "every model call is gateway-routed" is a property of the code rather than a promise in a
 *   README.
 */

import type { Logger } from '@adrianhall/cloudflare-toolkit/logging';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { InferencePort, InferenceRequest, InferenceResult } from '../domain/inference';

/**
 * Header asking AI Gateway to log metadata without retaining request and response payloads.
 *
 * This matters more here than in a playground: the payloads are a salesperson's question and the
 * product's answer, and the specification forbids retaining prompts, transcripts, or model output
 * in routine logs. The gateway log is wanted for cost, latency, and cache state; the content is
 * already durable in D1, where retention is configurable.
 *
 * It travels as an extra header because `GatewayOptions` exposes no payload-collection field, which
 * also means the application cannot verify it was honoured. The product therefore does not promise
 * a requester that their question is unlogged upstream; it simply does not ask for it to be
 * stored.
 */
const COLLECT_LOG_PAYLOAD_HEADER = 'cf-aig-collect-log-payload';

/**
 * Custom metadata recorded on every AI Gateway log.
 *
 * Declared as a type alias rather than an interface so it stays assignable to the binding's
 * `Record<string, string | number | boolean | null | bigint>` metadata parameter: an interface has
 * no implicit index signature and would need a cast at the call site, which is exactly the kind of
 * cast that later hides a genuine mismatch.
 *
 * Every field is an identifier. The specification permits a verified identity key and a request
 * identifier in gateway metadata, and forbids content — so the question, the evidence, and the
 * answer appear nowhere in this object.
 */
type GatewayMetadata = {
  /**
   * Which step of the workflow made the call.
   */
  role: string;
  /**
   * Conversation the call belongs to, so one conversation's calls group in the dashboard.
   */
  conversationId: string;
  /**
   * Correlation identifier tying this gateway log to the Worker logs for the same request.
   */
  correlationId: string;
  /**
   * Verified identity key of the requester. A key rather than the email: it attributes the charge
   * without copying a verified email address into an upstream log, which the specification lists
   * among the values that must not be logged.
   */
  identityKey: string;
  /**
   * Reviewed contract version of the model descriptor used.
   */
  contractVersion: number;
};

/**
 * Build the gateway metadata for one call.
 *
 * The actor is a required parameter read only from the verified Access identity. There is no
 * overload that accepts an email from a header or body, so an attacker-supplied identity field has
 * nowhere to go rather than being removed by a filter somebody might later delete.
 *
 * @param request The call being made.
 * @returns Metadata ready to pass as the gateway `metadata` option.
 * @throws {Error} When the actor carries no identity key. That means the Access middleware did not
 *   run or produced an unusable identity, and the correct response is to fail rather than send an
 *   unattributable request to a paid provider.
 */
function buildGatewayMetadata(request: InferenceRequest): GatewayMetadata {
  const identityKey = request.actor.identityKey.trim();
  if (identityKey === '') {
    throw new Error(
      'Refusing to send an inference request with no verified identity: AI Gateway metadata must '
        + 'attribute every request to the signed-in identity.'
    );
  }

  return {
    role: request.model.role,
    conversationId: request.conversationId,
    correlationId: request.correlationId,
    identityKey,
    contractVersion: request.model.contractVersion
  };
}

/**
 * Answer whether a thrown value is the requester's own cancellation.
 *
 * Cancellation has to be distinguishable from a provider failure because the two call for opposite
 * handling: a failure is logged as a fault and reported to the requester, while a cancellation is
 * the requester getting what they asked for and must produce no error frame and no persisted turn.
 *
 * @param cause Value thrown by the binding.
 * @returns Whether the call was aborted rather than failed.
 */
export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

/**
 * Reduce an arbitrary thrown value to structured, content-free log fields.
 *
 * The provider's own message is the most useful thing when a model call fails — a rejected
 * parameter, a capacity error — and it goes in the operator's log. It never goes to the requester:
 * it can carry prompt fragments and internal endpoint names.
 *
 * @param cause Value thrown by the binding.
 * @returns Name and message fields for a structured log.
 */
function describeCause(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    return { errorName: cause.name, errorMessage: cause.message };
  }
  return { errorName: 'NonError', errorMessage: typeof cause === 'string' ? cause : 'unknown' };
}

/**
 * Read the generated text out of a Workers AI text-generation response.
 *
 * The catalogue carries two shapes: the Workers AI native `{ response }` and the OpenAI-compatible
 * `choices[0].message.content`. Both are accepted so a future reviewed model can be either without
 * a second code path; anything else yields an empty string, which the caller treats as a provider
 * failure rather than as an empty answer.
 *
 * @param output Value returned by the binding.
 * @returns The generated text, or an empty string when the shape is unrecognized.
 */
export function extractGeneratedText(output: unknown): string {
  if (typeof output !== 'object' || output === null) {
    return '';
  }
  const record = output as Record<string, unknown>;
  if (typeof record.response === 'string') {
    return record.response;
  }
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown> | undefined)?.message as
      | Record<string, unknown>
      | undefined;
    if (typeof message?.content === 'string') {
      return message.content;
    }
  }
  return '';
}

/**
 * Dependencies the gateway client needs.
 */
export interface GatewayInferenceClientOptions {
  /**
   * The Workers AI binding.
   */
  ai: Ai;
  /**
   * Identifier of the AI Gateway every request must travel through, from the `AI_GATEWAY_ID`
   * binding Terraform's output populates.
   */
  gatewayId: string;
  /**
   * Where provider failures are recorded. The client logs the provider's own message here and
   * returns a sanitized one to the caller, which is the only arrangement satisfying both
   * requirements at once: a requester must not see provider internals, and an operator must not be
   * left guessing.
   */
  logger?: Logger;
}

/**
 * Runs reviewed Workers AI models through this demo's AI Gateway.
 *
 * Constructed once per request in the Worker's composition root and injected as an
 * {@link InferencePort}. Nothing above the infrastructure tier knows this class exists.
 */
export class GatewayInferenceClient implements InferencePort {
  /**
   * The Workers AI binding. Private and `#`-prefixed so the isolation test's pattern for a direct
   * binding use (`#ai.run`) matches only inside this file.
   */
  readonly #ai: Ai;

  /**
   * Gateway every call is routed through.
   */
  readonly #gatewayId: string;

  /**
   * Operator log for provider failures.
   */
  readonly #logger: Logger | undefined;

  /**
   * Create a client bound to one gateway.
   *
   * @param options The Workers AI binding, the gateway identifier, and an optional logger.
   * @throws {Error} When the gateway identifier is missing or blank. This fails at construction
   *   rather than at the first call on purpose: an unconfigured gateway is a broken deployment, and
   *   the failure should be immediate instead of surfacing later as a request that quietly reached
   *   a provider with no observability and no rate limit.
   */
  public constructor(options: GatewayInferenceClientOptions) {
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
   * Run one model call through AI Gateway.
   *
   * The gateway options are assembled in exactly one place — {@link GatewayInferenceClient.run} is
   * the only method that calls the binding — so there is no code path that can produce a call
   * without them. `collectLog` is always `true`: the gateway log is how a specific answer is traced
   * back to what it cost and how long it took.
   *
   * @param request The call to make, including the verified actor and reviewed model.
   * @returns The generated text, the gateway log identifier when one was assigned, and the measured
   *   duration.
   * @throws {Error} When the verified actor carries no identity key, or when the call is aborted by
   *   the requester's cancellation — the `AbortError` is re-thrown unchanged so the caller can tell
   *   a cancellation from a fault.
   * @throws {ProblemDetailsError} `502` when the provider or gateway fails, or returns a shape
   *   carrying no text. The provider's own message is deliberately discarded; it is logged
   *   instead.
   */
  public async generate(request: InferenceRequest): Promise<InferenceResult> {
    const metadata = buildGatewayMetadata(request);
    const startedAt = Date.now();

    try {
      const output = await this.#ai.run(
        request.model.id,
        {
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt }
          ],
          max_tokens: request.model.maxTokens,
          temperature: request.model.temperature
        },
        {
          gateway: { id: this.#gatewayId, collectLog: true, metadata },
          extraHeaders: { [COLLECT_LOG_PAYLOAD_HEADER]: 'false' },
          ...(request.signal === undefined ? {} : { signal: request.signal })
        }
      );

      const text = extractGeneratedText(output);
      if (text.trim() === '') {
        throw this.#providerFailure(request, new Error('empty_generation'), startedAt);
      }

      return {
        text,
        // Read immediately after the call: the binding exposes the log identifier of its most
        // recent request, so anything awaited in between could overwrite it.
        ...(this.#ai.aiGatewayLogId === null ? {} : { logId: this.#ai.aiGatewayLogId }),
        elapsedMs: Date.now() - startedAt
      };
    } catch (cause: unknown) {
      if (isAbortError(cause) || cause instanceof ProblemDetailsError) {
        throw cause;
      }
      throw this.#providerFailure(request, cause, startedAt);
    }
  }

  /**
   * Log a provider failure in full and build the sanitized error to raise.
   *
   * Both jobs are in one method deliberately, because doing only one of them is the bug this
   * arrangement avoids. The provider's message cannot go to the browser, but discarding it entirely
   * leaves a `502` with nothing behind it and no way to tell which call failed or why.
   *
   * The log records the shape of the call, never its content: the model, the role, the conversation
   * and correlation identifiers, the prompt's _length_, and the gateway log identifier when one was
   * assigned. The question text, the evidence, and the generated answer are all excluded.
   *
   * @param request The call that failed.
   * @param cause The value the binding threw.
   * @param startedAt Epoch milliseconds the attempt began, used to report its duration.
   * @returns A `502` problem-details error with a message a requester can act on.
   */
  #providerFailure(
    request: InferenceRequest,
    cause: unknown,
    startedAt: number
  ): ProblemDetailsError {
    this.#logger?.error('inference_provider_failed', {
      role: request.model.role,
      model: request.model.id,
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      gatewayId: this.#gatewayId,
      contractVersion: request.model.contractVersion,
      promptLength: request.prompt.length,
      elapsedMs: Date.now() - startedAt,
      // The gateway may have assigned a log before failing. When it did, this ties the Worker log
      // to the dashboard entry; when it did not, the absence is itself the finding — the request
      // never reached the gateway.
      gatewayLogId: this.#ai.aiGatewayLogId,
      ...describeCause(cause)
    });

    return new ProblemDetailsError({
      status: 502,
      title: 'The assistant could not complete this request',
      detail: 'The model did not return a usable answer. Try again, or ask for a product manager.'
    });
  }
}
