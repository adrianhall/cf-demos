/**
 * @file The Chat use case. It owns the sequence a Chat run goes through — validate, call the model
 *   through the gateway, record the run, build the receipt — and knows nothing about HTTP. The
 *   route turns its output into SSE frames; the service would behave identically behind a WebSocket
 *   or a queue consumer, which is the test of whether a use case has stayed in the application
 *   tier. It depends on {@link InferencePort} and {@link RunRepositoryPort}, never on `env.AI` or a
 *   concrete store, so every test in this phase exercises the real sequencing offline.
 */

import type { RunReceipt } from '../../../shared/runs';
import type { ValidatedChatRequest } from '../../domain/chat';
import { buildChatInput } from '../../domain/chat';
import { initialCostStatus } from '../../domain/metrics';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a streamed Chat run yields to its caller.
 */
export interface ChatRunStream {
  /**
   * Text increments as the model generates them.
   */
  chunks: AsyncIterable<string>;
  /**
   * Builds the receipt once the stream has finished.
   *
   * A function called after iteration rather than a value available up front: the gateway log
   * identifier does not exist until the stream settles, and a receipt without it would send the
   * browser polling for a log it could never name.
   *
   * @returns The run receipt, already persisted for a later metrics lookup.
   */
  complete: () => Promise<RunReceipt>;
}

/**
 * Dependencies of {@link ChatService}.
 */
export interface ChatServiceOptions {
  /**
   * Gateway-routed inference, injected by the Worker's composition root.
   */
  inference: InferencePort;
  /**
   * Where run records are kept until their metrics are read.
   */
  runs: RunRepositoryPort;
  /**
   * Clock reading epoch milliseconds. Injected so a test can assert on timing without waiting.
   */
  now?: () => number;
}

/**
 * Runs Chat requests through AI Gateway.
 */
export class ChatService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock; see
   *   {@link ChatServiceOptions}.
   */
  constructor(options: ChatServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Starts a streamed Chat run.
   *
   * The run record is written when the stream completes rather than when it starts, because its
   * purpose is to authorise a metrics lookup and there is nothing to look up until a log identifier
   * exists. A run abandoned mid-stream therefore leaves no record, which is correct: it has no
   * resolvable cost to ask about.
   *
   * @param request A validated Chat request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The text stream and a receipt builder; see {@link ChatRunStream}.
   * @throws {ProblemDetailsError} With `502` when the provider fails before streaming begins.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async streamChat(request: ValidatedChatRequest, actor: VerifiedActor): Promise<ChatRunStream> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const stream = await this.#inference.runStream({
      task: 'chat',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildChatInput(request, true)
    });

    return {
      chunks: stream.chunks,
      complete: async (): Promise<RunReceipt> => {
        const logId = stream.logId();
        const logIds = logId === undefined ? [] : [logId];

        const receipt: RunReceipt = {
          runId: request.runId,
          task: 'chat',
          model: request.model.id,
          // Always true for this panel: the only call path is through the gateway client. The field
          // exists so a documented exception could report `false` and be rendered differently,
          // rather than a panel quietly losing observability while the badge still says otherwise.
          gatewayRouted: true,
          logIds,
          status: 'completed',
          costStatus: initialCostStatus(logIds),
          elapsedMs: this.#now() - startedAtMs,
          startedAt
        };

        await this.#runs.save({
          runId: receipt.runId,
          task: receipt.task,
          model: receipt.model,
          // The owner is the verified identity, so the later metrics request compares like with
          // like. A run identifier is guessable; the identity that may read it is not.
          ownerEmail: actor.email,
          logIds,
          status: receipt.status,
          startedAtMs
        });

        return receipt;
      }
    };
  }
}
