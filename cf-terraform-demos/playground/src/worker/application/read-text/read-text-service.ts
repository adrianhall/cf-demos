/**
 * @file The Read Text use case: call the model through the gateway, normalise whatever shape it
 *   returned into verified audio bytes, record the run, and build the receipt. Normalisation is the
 *   substance of this service, exactly as it is for Create Image, and the reviewed models make it
 *   necessary rather than defensive. Aura returns a `ReadableStream` of audio; MeloTTS declares
 *   _two_ possible output shapes in one schema — a raw MP3 byte stream, or `{ audio: "<base64>" }`
 *   in a JSON body — and does not say which to expect. A service that handled only one of those
 *   would work until it didn't. Whatever the shape, the bytes are identified by signature before
 *   they are returned. A provider that answered with a JSON error document under a success status,
 *   or with raw headerless PCM — which Aura's schema genuinely permits — fails here rather than
 *   reaching a `data:` URI in the page labelled as playable audio.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_SPEECH_BYTES,
  type AppliedSpeechControls,
  type GeneratedSpeech
} from '../../../shared/read-text';
import type { RunReceipt } from '../../../shared/runs';
import { readAudioDurationSeconds, sniffAudioMediaType } from '../../domain/audio-bytes';
import { decodeBase64, encodeBase64 } from '../../domain/image-bytes';
import { initialCostStatus } from '../../domain/metrics';
import {
  buildReadTextInput,
  describeAppliedSpeechControls,
  type ValidatedReadTextRequest
} from '../../domain/read-text';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Read Text run produced.
 */
export interface ReadTextResult {
  /**
   * The verified audio; see {@link GeneratedSpeech}.
   */
  speech: GeneratedSpeech;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the audio was generated with, including filled-in model defaults.
   */
  applied: AppliedSpeechControls;
  /**
   * Duration in seconds when it could be read cheaply from the container, otherwise `undefined`.
   *
   * Only WAV carries this reliably in its header. An MP3's duration needs either a constant-bitrate
   * assumption that is wrong for real encoder output, or a walk of every frame; the panel reads the
   * true value from the audio element instead, so this is left absent rather than estimated.
   */
  durationSeconds?: number;
}

/**
 * Dependencies of {@link ReadTextService}.
 */
export interface ReadTextServiceOptions {
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
 * Turns text into speech through AI Gateway.
 */
export class ReadTextService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock and logger; see
   *   {@link ReadTextServiceOptions}.
   */
  constructor(options: ReadTextServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one speech generation.
   *
   * A single synchronous call, like Create Image and unlike Create Video: a speech model returns
   * its audio within the request, so the receipt is complete by the time this method returns and
   * the run record is written before it does. There is no window in which the browser holds a
   * receipt the server cannot resolve.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The audio, receipt, applied controls, and duration where known; see
   *   {@link ReadTextResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, returns something that is not
   *   audio, returns a format this panel cannot play, or returns audio over
   *   {@link MAX_SPEECH_BYTES}.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async generate(request: ValidatedReadTextRequest, actor: VerifiedActor): Promise<ReadTextResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'read-text',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildReadTextInput(request)
    });

    const { speech, durationSeconds } = await normaliseSpeechOutput(result.output, this.#logger);

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'read-text',
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

    return {
      speech,
      receipt,
      applied: describeAppliedSpeechControls(request),
      ...(durationSeconds === undefined ? {} : { durationSeconds })
    };
  }
}

/**
 * Turns whatever a text-to-speech model returned into verified audio bytes.
 *
 * Three shapes are accepted, because the reviewed catalogue genuinely contains all three:
 *
 * - A `ReadableStream` of bytes, as both Aura models return;
 * - `{ audio: "<base64>" }`, which MeloTTS's output schema declares as one of its two options;
 * - An `ArrayBuffer`/`Uint8Array`, which the binding produces for some models.
 *
 * Every path converges on the same signature check, so no shape is trusted more than another.
 *
 * @param output The provider's raw output.
 * @param logger Where a refusal is recorded, so an operator can tell a rejected output from a
 *   provider error.
 * @returns The verified audio with its media type determined from its content, and its duration
 *   where the container declares one.
 * @throws {ProblemDetailsError} With `502` when the output is not one of the recognised shapes, is
 *   not playable audio, or exceeds the size cap.
 */
async function normaliseSpeechOutput(
  output: unknown,
  logger?: DiagnosticLogger
): Promise<{ speech: GeneratedSpeech; durationSeconds?: number }> {
  const bytes = await extractBytes(output);

  if (bytes === undefined || bytes.length === 0) {
    // Logged with a description of what the provider actually sent. A refusal here looks identical
    // to a provider error from the browser's point of view, so without this line the two are
    // indistinguishable in an incident — and they have completely different fixes.
    logger?.error('read_text_output_unusable', {
      reason: bytes === undefined ? 'unrecognised_shape' : 'empty',
      ...describeOutput(output)
    });
    throw speechFailure(
      'The model did not return any audio. Try again, or choose a different model for this panel.'
    );
  }

  // Checked after reading, because a stream's length is not known in advance. The read itself is
  // bounded by the same cap, so an unbounded provider response cannot exhaust the isolate.
  if (bytes.length > MAX_SPEECH_BYTES) {
    logger?.error('read_text_output_unusable', {
      reason: 'too_large',
      byteLength: bytes.length,
      maxBytes: MAX_SPEECH_BYTES
    });
    throw speechFailure('The generated audio was larger than this demo will relay.');
  }

  // The declared content type is deliberately never consulted. A `data:` URI's media type decides
  // how the browser treats the payload, so it is derived from the bytes themselves. This is also
  // what catches raw headerless PCM, which Aura's schema permits and no browser will play.
  const mediaType = sniffAudioMediaType(bytes);
  if (mediaType === undefined) {
    logger?.error('read_text_output_unusable', {
      reason: 'unplayable_format',
      byteLength: bytes.length,
      // The first bytes in hex, which is how a sniff failure is diagnosed: it reveals whether the
      // payload was raw PCM, a JSON error document, or HTML, without logging the payload itself.
      signature: [...bytes.subarray(0, 12)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')
    });
    throw speechFailure(
      'The model returned data this demo will not play as audio. Only MP3 and WAV are accepted.'
    );
  }

  const durationSeconds = readAudioDurationSeconds(bytes, mediaType);

  return {
    speech: { base64: encodeBase64(bytes), mediaType, byteLength: bytes.length },
    ...(durationSeconds === undefined ? {} : { durationSeconds })
  };
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
    // MeloTTS's JSON option. The field is `audio` rather than Create Image's `image`, which is the
    // only reason this is not the same function as that panel's: the envelope key is part of each
    // model's contract.
    if (typeof record['audio'] === 'string') {
      return decodeBase64(record['audio']);
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
 *   {@link MAX_SPEECH_BYTES}.
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
      if (total > MAX_SPEECH_BYTES) {
        throw speechFailure('The generated audio was larger than this demo will relay.');
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
 * Builds the sanitised error returned when audio cannot be produced or trusted.
 *
 * @param detail Explanation written for a visitor.
 * @returns A `502` problem-details error.
 */
function speechFailure(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The audio could not be generated',
    detail
  });
}
