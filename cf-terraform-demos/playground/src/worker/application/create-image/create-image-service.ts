/**
 * @file The Create Image use case: call the model through the gateway, normalise whatever shape it
 *   returned into verified image bytes, record the run, and build the receipt. Normalisation is the
 *   substance of this service. The two reviewed models return an image in genuinely different ways
 *   — one as `{ image: "<base64>" }` in a JSON body, the other as a raw PNG byte stream — and a
 *   third model added later could do something else again. Keeping that knowledge here means the
 *   route deals in a single `GeneratedImage` and the browser never learns that providers disagree.
 *   Whatever the shape, the bytes are identified by signature before they are returned. A provider
 *   that answered with a JSON error document under a success status, or with a format this panel
 *   does not render, fails here rather than reaching a `data:` URI in the page.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_IMAGE_BYTES,
  type AppliedImageControls,
  type GeneratedImage
} from '../../../shared/images';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildCreateImageInput,
  describeAppliedControls,
  type ValidatedCreateImageRequest
} from '../../domain/create-image';
import { decodeBase64, encodeBase64, sniffImageMediaType } from '../../domain/image-bytes';
import { initialCostStatus } from '../../domain/metrics';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Create Image run produced.
 */
export interface CreateImageResult {
  /**
   * The verified image; see {@link GeneratedImage}.
   */
  image: GeneratedImage;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the image was generated with, including filled-in model defaults.
   */
  applied: AppliedImageControls;
}

/**
 * Dependencies of {@link CreateImageService}.
 */
export interface CreateImageServiceOptions {
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
  /**
   * Where an unusable provider output is recorded.
   *
   * A refusal here is indistinguishable from a provider error at the HTTP boundary — both are a
   * `502` — but the two have entirely different causes, so the distinction has to be recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Generates images through AI Gateway.
 */
export class CreateImageService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock; see
   *   {@link CreateImageServiceOptions}.
   */
  constructor(options: CreateImageServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one image generation.
   *
   * Unlike Chat this is a single synchronous call, so the receipt is complete by the time the
   * method returns and the run record is written before it does — there is no window in which the
   * browser holds a receipt the server cannot resolve.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The image, receipt, and applied controls; see {@link CreateImageResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, returns something that is not
   *   an image, returns a format this panel does not render, or returns an image over
   *   {@link MAX_IMAGE_BYTES}.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async generate(
    request: ValidatedCreateImageRequest,
    actor: VerifiedActor
  ): Promise<CreateImageResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'create-image',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildCreateImageInput(request)
    });

    const image = await normaliseImageOutput(result.output, this.#logger);

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'create-image',
      model: request.model.id,
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
      ownerEmail: actor.email,
      logIds,
      status: receipt.status,
      startedAtMs
    });

    return { image, receipt, applied: describeAppliedControls(request) };
  }
}

/**
 * Turns whatever a text-to-image model returned into verified image bytes.
 *
 * Three shapes are accepted, because the reviewed catalog genuinely contains all three:
 *
 * - A `ReadableStream` of bytes, as Stable Diffusion XL returns;
 * - `{ image: "<base64>" }`, as FLUX.1 returns;
 * - An `ArrayBuffer`/`Uint8Array`, which the binding produces for some models.
 *
 * Every path converges on the same signature check, so no shape is trusted more than another.
 *
 * @param output The provider's raw output.
 * @param logger Where a refusal is recorded, so an operator can tell a rejected output from a
 *   provider error.
 * @returns The verified image, with its media type determined from its content.
 * @throws {ProblemDetailsError} With `502` when the output is not one of the recognised shapes, is
 *   not a renderable image, or exceeds the size cap.
 */
async function normaliseImageOutput(
  output: unknown,
  logger?: DiagnosticLogger
): Promise<GeneratedImage> {
  const bytes = await extractBytes(output);

  if (bytes === undefined || bytes.length === 0) {
    // Logged with a description of what the provider actually sent. A refusal here looks identical
    // to a provider error from the browser's point of view, so without this line the two are
    // indistinguishable in an incident — and they have completely different fixes.
    logger?.error('create_image_output_unusable', {
      reason: bytes === undefined ? 'unrecognised_shape' : 'empty',
      ...describeOutput(output)
    });
    throw imageFailure(
      'The model did not return an image. Try again, or choose a different model for this panel.'
    );
  }

  // Checked after reading, because a stream's length is not known in advance. The read itself is
  // bounded by the same cap, so an unbounded provider response cannot exhaust the isolate.
  if (bytes.length > MAX_IMAGE_BYTES) {
    logger?.error('create_image_output_unusable', {
      reason: 'too_large',
      byteLength: bytes.length,
      maxBytes: MAX_IMAGE_BYTES
    });
    throw imageFailure('The generated image was larger than this demo will relay.');
  }

  // The declared content type is deliberately never consulted. A `data:` URI's media type decides
  // how the browser treats the payload, so it is derived from the bytes themselves.
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    logger?.error('create_image_output_unusable', {
      reason: 'unrenderable_format',
      byteLength: bytes.length,
      // The first bytes in hex, which is how a sniff failure is diagnosed: it reveals whether the
      // payload was a GIF, a JSON error document, or HTML, without logging the payload itself.
      signature: [...bytes.subarray(0, 12)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')
    });
    throw imageFailure(
      'The model returned data this demo will not render as an image. Only PNG, JPEG, and WebP '
        + 'are accepted.'
    );
  }

  return { base64: encodeBase64(bytes), mediaType, byteLength: bytes.length };
}

/**
 * Describes an unrecognised provider output for a log.
 *
 * Reports the output's _shape_ — its type, constructor, and top-level keys — never its content. A
 * model that changed its response envelope is identified immediately from the key list.
 *
 * @param output The provider's raw output.
 * @returns Structured fields describing the shape.
 */
function describeOutput(output: unknown): Record<string, unknown> {
  if (output === null || output === undefined) {
    return { outputType: String(output) };
  }

  if (typeof output !== 'object') {
    return { outputType: typeof output };
  }

  return {
    outputType: 'object',
    outputConstructor: output.constructor.name,
    outputKeys: Object.keys(output as Record<string, unknown>)
  };
}

/**
 * Pulls raw bytes out of a provider output of any recognised shape.
 *
 * @param output The provider's raw output.
 * @returns The bytes, or `undefined` when the shape is unrecognised.
 * @throws {ProblemDetailsError} With `502` when a streamed response exceeds the size cap, which is
 *   detected while reading rather than after buffering everything.
 */
async function extractBytes(output: unknown): Promise<Uint8Array | undefined> {
  if (output instanceof ReadableStream) {
    return readStreamBounded(output as ReadableStream<Uint8Array>);
  }

  if (output instanceof Uint8Array) {
    return output;
  }

  if (output instanceof ArrayBuffer) {
    return new Uint8Array(output);
  }

  if (typeof output === 'object' && output !== null) {
    const record = output as Record<string, unknown>;
    if (typeof record['image'] === 'string') {
      return decodeBase64(record['image']);
    }
  }

  return undefined;
}

/**
 * Reads a byte stream, refusing to buffer more than the cap allows.
 *
 * The limit is enforced during the read rather than after it. Buffering an unbounded provider
 * response and only then measuring it would let a misbehaving upstream exhaust the isolate's memory
 * before the check ran.
 *
 * @param stream Byte stream from the provider.
 * @returns The concatenated bytes.
 * @throws {ProblemDetailsError} With `502` once the accumulated size exceeds
 *   {@link MAX_IMAGE_BYTES}.
 */
async function readStreamBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        throw imageFailure('The generated image was larger than this demo will relay.');
      }

      chunks.push(value);
    }
  } finally {
    // Runs on the size-limit throw as well as on normal completion, so an abandoned read releases
    // the upstream stream instead of leaving it open for the isolate's lifetime.
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

/**
 * Builds the sanitised error returned when an image cannot be produced or trusted.
 *
 * @param detail Explanation written for a visitor.
 * @returns A `502` problem-details error.
 */
function imageFailure(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The image could not be generated',
    detail
  });
}
