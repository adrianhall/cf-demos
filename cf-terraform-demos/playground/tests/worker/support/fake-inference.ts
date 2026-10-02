/**
 * @file A test double for {@link InferencePort}. Every Worker test in this phase runs against it,
 *   which is what keeps the suite offline: the real validation, receipt, ownership, and
 *   cost-aggregation logic is exercised without a network, an account, or a cent of spend. It
 *   records the requests it was given, because several tests assert on what _reached_ the inference
 *   boundary — particularly that gateway metadata carries the verified email and not something from
 *   a request body.
 */

import type { GatewayRequestMetric } from '../../../src/shared/runs';
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
  InferenceStream
} from '../../../src/worker/application/ports/inference-port';

/**
 * Behaviour and recorded calls of a {@link FakeInference}.
 */
export interface FakeInferenceOptions {
  /**
   * Text increments the streamed call yields.
   */
  chunks?: string[];
  /**
   * Gateway log identifier the call reports, or `null` for none.
   */
  logId?: string | null;
  /**
   * Metrics returned per log identifier. A log absent from this map is reported as unpropagated.
   */
  metrics?: Record<string, GatewayRequestMetric>;
  /**
   * Error thrown instead of streaming, used to exercise the failure paths.
   */
  failWith?: Error;
  /**
   * Error thrown partway through the stream, after `failAfter` chunks.
   */
  failMidStream?: Error;
  /**
   * How many chunks to yield before `failMidStream` is thrown.
   */
  failAfter?: number;
  /**
   * Exact output the synchronous call returns, replacing the default text shape.
   *
   * Needed because providers genuinely disagree about output shape: a text model answers `{
   * response }`, one image model answers `{ image: "<base64>" }`, and another answers with a raw
   * byte stream. A fake that could only produce one shape could not exercise the normalisation that
   * exists precisely to absorb that disagreement.
   *
   * A function rather than a value, so a test can hand over a fresh `ReadableStream` per call — a
   * stream is single-use, and a shared one would be consumed by the first test to read it.
   */
  output?: () => unknown;
}

/**
 * An in-memory {@link InferencePort}.
 */
export class FakeInference implements InferencePort {
  /**
   * Every request passed to {@link FakeInference.run} or {@link FakeInference.runStream}, in order.
   */
  readonly requests: InferenceRequest<unknown>[] = [];

  /**
   * Log identifiers passed to {@link FakeInference.readMetric}, in order, so a test can assert that
   * a run's logs were each resolved exactly once.
   */
  readonly metricLookups: string[] = [];

  readonly #options: FakeInferenceOptions;

  /**
   * Creates the double.
   *
   * @param options Behaviour to simulate; see {@link FakeInferenceOptions}.
   */
  constructor(options: FakeInferenceOptions = {}) {
    this.#options = options;
  }

  /**
   * Records a synchronous call and returns the configured output.
   *
   * @typeParam TInput Model-specific input payload.
   * @typeParam TOutput Model-specific output payload.
   * @param request The call being made.
   * @returns The configured `output` when one was given, otherwise the joined chunks as a
   *   `response` field, mirroring the real text-generation contract.
   * @throws {Error} The configured `failWith`, when one was given.
   */
  async run<TInput, TOutput>(request: InferenceRequest<TInput>): Promise<InferenceResult<TOutput>> {
    this.requests.push(request as InferenceRequest<unknown>);
    if (this.#options.failWith) {
      throw this.#options.failWith;
    }

    const output =
      this.#options.output === undefined
        ? { response: (this.#options.chunks ?? []).join('') }
        : this.#options.output();

    return {
      output: output as TOutput,
      ...(this.#logId() === undefined ? {} : { logId: this.#logId() }),
      elapsedMs: 1
    };
  }

  /**
   * Records a streamed call and yields the configured chunks.
   *
   * @typeParam TInput Model-specific input payload.
   * @param request The call being made.
   * @returns The chunk stream and a log-identifier reader; see {@link InferenceStream}.
   * @throws {Error} The configured `failWith`, before streaming begins.
   */
  async runStream<TInput>(request: InferenceRequest<TInput>): Promise<InferenceStream> {
    this.requests.push(request as InferenceRequest<unknown>);
    if (this.#options.failWith) {
      throw this.#options.failWith;
    }

    const chunks = this.#options.chunks ?? [];
    const failMidStream = this.#options.failMidStream;
    const failAfter = this.#options.failAfter ?? 0;

    return {
      chunks: (async function* yieldChunks(): AsyncGenerator<string> {
        for (const [index, chunk] of chunks.entries()) {
          if (failMidStream !== undefined && index >= failAfter) {
            throw failMidStream;
          }
          yield chunk;
        }
        if (failMidStream !== undefined && chunks.length <= failAfter) {
          throw failMidStream;
        }
      })(),
      logId: () => this.#logId()
    };
  }

  /**
   * Returns the configured metric for a log, or `undefined` when it has not "propagated".
   *
   * @param logId Log identifier to resolve.
   * @returns The metric, or `undefined` when none was configured for this log.
   */
  async readMetric(logId: string): Promise<GatewayRequestMetric | undefined> {
    this.metricLookups.push(logId);
    return this.#options.metrics?.[logId];
  }

  /**
   * The configured log identifier.
   *
   * @returns The identifier, or `undefined` when configured as absent. Defaults to `log-1` so a
   *   test that does not care about logs still produces a pollable run.
   */
  #logId(): string | undefined {
    if (this.#options.logId === null) {
      return undefined;
    }
    return this.#options.logId ?? 'log-1';
  }
}

/**
 * Drains an async iterable into an array.
 *
 * @param iterable Stream to consume.
 * @returns Every value the stream yielded, in order.
 * @throws {Error} Whatever the stream threw.
 */
export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}
