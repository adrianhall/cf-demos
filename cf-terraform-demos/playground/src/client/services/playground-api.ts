/**
 * @file The browser's only route to the Worker's API. Keeping every `fetch` for inference and
 *   metrics in one module means a composable deals in typed events and typed results rather than in
 *   response parsing, and there is one place to look when asking what the client actually sends.
 */

import type { ChatRequest, ChatStreamEvent } from '../../shared/chat';
import type { ClassifyImageRequest, ClassifyImageResponse } from '../../shared/classify-image';
import type { ClassifyTextRequest, ClassifyTextResponse } from '../../shared/classify-text';
import type {
  CreateVideoAcceptedResponse,
  CreateVideoRequest,
  CreateVideoStatusResponse
} from '../../shared/create-video';
import type { DescribeImageRequest, DescribeImageResponse } from '../../shared/describe-image';
import type { CreateImageRequest, CreateImageResponse } from '../../shared/images';
import type { ReadTextRequest, ReadTextResponse } from '../../shared/read-text';
import type { RemixImageRequest, RemixImageResponse } from '../../shared/remix-image';
import type { RunMetrics } from '../../shared/runs';
import { parseSseBuffer } from '../../shared/sse';
import type {
  TranscribeAudioRequest,
  TranscribeAudioResponse
} from '../../shared/transcribe-audio';
import type { TranslateTextRequest, TranslateTextResponse } from '../../shared/translate-text';

/**
 * Thrown when the API answers a non-streaming request with a failure.
 *
 * Carries the status and the RFC 9457 detail, so a caller can show the server's own explanation
 * instead of a generic message — the server's version is the one written for a visitor.
 */
export class ApiError extends Error {
  /**
   * HTTP status the server returned.
   */
  readonly status: number;

  /**
   * Creates the error.
   *
   * @param status HTTP status from the response.
   * @param message Human-readable detail, taken from the problem document when there was one.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Extracts a displayable message from a failed response.
 *
 * @param response The failed response.
 * @returns The problem document's `detail`, or a status-based fallback when the body is not a
 *   problem document — which happens when an infrastructure layer rather than the Worker produced
 *   the failure.
 */
async function failureMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as { detail?: string; title?: string };
    return problem.detail ?? problem.title ?? `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

/**
 * Starts a Chat run and yields its typed stream events.
 *
 * Implemented over `fetch` rather than `EventSource` because the prompt is sent in a `POST` body:
 * `EventSource` can only issue `GET` requests, which would put the prompt in a URL that lands in
 * browser history and any intermediary's logs.
 *
 * @param request The Chat request to send.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring what continues to arrive.
 * @returns An async iterable of typed events, in the order the server sent them.
 * @throws {ApiError} When the server rejects the request before streaming begins — a validation
 *   failure, an expired Access session, or a body over the limit. A failure _during_ the stream
 *   arrives as a `problem` event instead, because the response has already started.
 */
export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  if (response.body === null) {
    throw new ApiError(response.status, 'The server returned an empty response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // `stream: true` so a chunk boundary inside a multi-byte character is held over rather than
      // decoded as a replacement character — which would corrupt any non-ASCII answer.
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;

      for (const frame of parsed.frames) {
        const event = parseEvent(frame.data);
        if (event !== undefined) {
          yield event;
        }
      }
    }
  } finally {
    // Runs when the consumer breaks out of the loop as well as on normal completion, so a cancelled
    // run releases the stream instead of leaving it dangling.
    reader.releaseLock();
  }
}

/**
 * Parses one frame's payload into a typed event.
 *
 * @param data The frame's `data` field.
 * @returns The event, or `undefined` when the payload is not one of the four known shapes. An
 *   unrecognised frame is skipped rather than thrown on: a keep-alive or a newer server event
 *   should not destroy an answer the visitor is already reading.
 */
function parseEvent(data: string): ChatStreamEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const type = (parsed as { type?: unknown }).type;
  if (type === 'start' || type === 'delta' || type === 'completed' || type === 'problem') {
    return parsed as ChatStreamEvent;
  }

  return undefined;
}

/**
 * Generates one image.
 *
 * A single request/response rather than a stream: a diffusion model produces its image at the end
 * of its run, so there is nothing to deliver incrementally.
 *
 * @param request The image request to send.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result. The provider's work is not cancelled — and the panel says so —
 *   but the browser stops waiting.
 * @returns The generated image, its run receipt, and the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for an unsupported control or a
 *   malformed body, `401` for an expired Access session) or when the provider fails or returns
 *   something that is not a renderable image (`502`).
 */
export async function createImage(
  request: CreateImageRequest,
  signal?: AbortSignal
): Promise<CreateImageResponse> {
  const response = await fetch('/api/create-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as CreateImageResponse;
}

/**
 * Describes one picture.
 *
 * @param request The description request to send, carrying the base64 picture.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result.
 * @returns The description, the facts the server verified about the picture, its run receipt, and
 *   the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for an unsupported control, a
 *   missing required question, or a picture that is not an accepted format; `413` when the body is
 *   too large; `401` for an expired Access session) or when the provider fails or returns no usable
 *   description (`502`).
 */
export async function describeImage(
  request: DescribeImageRequest,
  signal?: AbortSignal
): Promise<DescribeImageResponse> {
  const response = await fetch('/api/describe-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as DescribeImageResponse;
}

/**
 * Transforms one image through the Remix Image endpoint.
 *
 * @param request Validated-by-UI image transformation request.
 * @param signal Abort signal that stops the browser waiting for the response.
 * @returns The transformed image, verified source facts, receipt, and applied controls.
 * @throws {ApiError} When the request is invalid, unauthorized, too large, or the provider returns
 *   an unusable image.
 */
export async function remixImage(
  request: RemixImageRequest,
  signal?: AbortSignal
): Promise<RemixImageResponse> {
  const response = await fetch('/api/remix-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }
  return (await response.json()) as RemixImageResponse;
}

/**
 * Classifies one picture.
 *
 * @param request The classification request to send, carrying the base64 picture and the result
 *   controls.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result.
 * @returns The ranked labels, how many the model returned, the facts the server verified about the
 *   picture, its run receipt, and the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for an unsupported or out-of-range
 *   control, a generative field, or a picture that is not an accepted format; `401` for an expired
 *   Access session) or when the provider fails or returns no usable labels (`502`).
 */
export async function classifyImage(
  request: ClassifyImageRequest,
  signal?: AbortSignal
): Promise<ClassifyImageResponse> {
  const response = await fetch('/api/classify-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as ClassifyImageResponse;
}

/**
 * Speaks one passage of text.
 *
 * A single request/response rather than a stream, and unlike Create Video there is no job to poll:
 * a speech model returns its complete audio within the request, and the bytes travel in the
 * response rather than being stored.
 *
 * @param request The speech request to send, carrying the text and the chosen controls.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result. The provider's work is not cancelled — and the panel says so —
 *   but the browser stops waiting.
 * @returns The generated audio, its run receipt, and the controls the server applied — including
 *   the cost estimate where the model's billing makes one possible.
 * @throws {ApiError} When the server rejects the request (`400` for an unsupported control, a voice
 *   the selected model does not publish, or an over-long passage; `401` for an expired Access
 *   session) or when the provider fails or returns something that is not playable audio (`502`).
 */
export async function readText(
  request: ReadTextRequest,
  signal?: AbortSignal
): Promise<ReadTextResponse> {
  const response = await fetch('/api/read-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as ReadTextResponse;
}

/**
 * Transcribes one recording.
 *
 * The exact inverse of {@link readText} in volume: the request carries several megabytes and the
 * response is a few kilobytes of text.
 *
 * @param request The transcription request to send, carrying the base64 audio and chosen controls.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result. The provider's work is not cancelled — and the panel says so —
 *   but the browser stops waiting, which matters more here than elsewhere because a long upload is
 *   the slowest part of this panel.
 * @returns The normalised transcript, what the server verified about the audio, the run receipt,
 *   and the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for a file beyond the selected
 *   model's own size ceiling, an unsupported control, a language code that model does not accept,
 *   or a file that is not audio; `401` for an expired Access session) or when the provider fails or
 *   returns no usable transcript (`502`).
 */
export async function transcribeAudio(
  request: TranscribeAudioRequest,
  signal?: AbortSignal
): Promise<TranscribeAudioResponse> {
  const response = await fetch('/api/transcribe-audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as TranscribeAudioResponse;
}

/**
 * Translates one passage.
 *
 * The text is sent with its line structure intact and the server does the segmenting, so one
 * request here can become several billed gateway calls — the count depends on the selected model's
 * contract. The response reports how many were actually made.
 *
 * @param request The translation request to send, carrying the source text and chosen languages.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result. Calls already made to the provider are not cancelled — and the
 *   panel says so — which matters more here than elsewhere, because a non-batching model may have
 *   several lines still to go.
 * @returns The assembled translation, the run receipt, and the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for a language the selected model
 *   does not accept, a source language on a fixed-source model, identical languages, or text that
 *   is too long or has too many lines; `401` for an expired Access session) or when the provider
 *   fails or returns no usable translation (`502`).
 */
export async function translateText(
  request: TranslateTextRequest,
  signal?: AbortSignal
): Promise<TranslateTextResponse> {
  const response = await fetch('/api/translate-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as TranslateTextResponse;
}

/**
 * Classifies one text against a reviewed model's own label set.
 *
 * The request carries no labels and has no field for them: the categories belong to the trained
 * model, and the server refuses a body that tries to supply them. For caller-defined questions,
 * Evaluate Choices is the separate task.
 *
 * @param request The classification request, carrying the text and any ranking controls the
 *   selected model declares.
 * @param signal Abort signal, so the caller's Cancel button aborts the HTTP request itself rather
 *   than merely ignoring the result. The provider call already made is not cancelled, and the panel
 *   says so.
 * @returns The outcome — a scored ranking or a verdict, depending on the model — with the run
 *   receipt and the controls the server applied.
 * @throws {ApiError} When the server rejects the request (`400` for text that is too long, a
 *   ranking control on a model that reports no scores, or an attempt to supply labels; `401` for an
 *   expired Access session) or when the provider fails or returns no usable classification
 *   (`502`).
 */
export async function classifyText(
  request: ClassifyTextRequest,
  signal?: AbortSignal
): Promise<ClassifyTextResponse> {
  const response = await fetch('/api/classify-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as ClassifyTextResponse;
}

/**
 * Reads the gateway metrics for one run.
 *
 * @param runId Run to read.
 * @returns The run's metrics, whose `costStatus` tells the caller whether to poll again.
 * @throws {ApiError} With `404` when the server no longer remembers the run, `403` when it belongs
 *   to another identity, or `401` when the Access session has expired.
 */
export async function fetchRunMetrics(runId: string): Promise<RunMetrics> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/metrics`);
  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }
  return (await response.json()) as RunMetrics;
}

/**
 * Starts generating a video.
 *
 * Returns as soon as the job has been accepted rather than when the video exists, which is the
 * whole point of the panel's design: generation outlives the request, so the browser polls
 * {@link fetchVideoStatus} from here.
 *
 * @param request The generation request, carrying the prompt and the chosen controls.
 * @param signal Abort signal, so a caller can abandon the start request itself.
 * @returns The accepted job's run identifier, state, and the controls the server applied —
 *   including the cost estimate it computed.
 * @throws {ApiError} With `400` when a control is unsupported or out of range, `409` when a job
 *   already exists for this run identifier, or `401` when the Access session has expired.
 */
export async function startVideo(
  request: CreateVideoRequest,
  signal?: AbortSignal
): Promise<CreateVideoAcceptedResponse> {
  const response = await fetch('/api/create-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal })
  });

  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }

  return (await response.json()) as CreateVideoAcceptedResponse;
}

/**
 * Reads the current state of one video job.
 *
 * @param runId Run to poll.
 * @returns The job's state, plus the stored video, receipt, and applied controls once it completes.
 * @throws {ApiError} With `404` when no job exists for the signed-in identity and this run
 *   identifier — which is also the answer for another visitor's job, deliberately — or `401` when
 *   the Access session has expired.
 */
export async function fetchVideoStatus(runId: string): Promise<CreateVideoStatusResponse> {
  const response = await fetch(`/api/create-video/${encodeURIComponent(runId)}/status`);
  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }
  return (await response.json()) as CreateVideoStatusResponse;
}

/**
 * Cancels a running video job.
 *
 * @param runId Run to cancel.
 * @returns The job's final reported state.
 * @throws {ApiError} With `404` when no such job exists for the signed-in identity, or `401` when
 *   the Access session has expired.
 */
export async function cancelVideo(runId: string): Promise<CreateVideoStatusResponse> {
  const response = await fetch(`/api/create-video/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST'
  });
  if (!response.ok) {
    throw new ApiError(response.status, await failureMessage(response));
  }
  return (await response.json()) as CreateVideoStatusResponse;
}

/**
 * Builds the URL a `<video>` element plays a finished run from.
 *
 * A URL rather than a fetch, because the element must issue its own requests: it asks for byte
 * ranges as the visitor seeks, and a body this module had already read could not answer them.
 *
 * @param runId Run whose video to play.
 * @returns The authenticated, same-origin URL of the stored video.
 */
export function videoUrl(runId: string): string {
  return `/api/create-video/${encodeURIComponent(runId)}/video`;
}
