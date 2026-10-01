/**
 * @file The browser's only route to the Worker's API. Keeping every `fetch` for inference and
 *   metrics in one module means a composable deals in typed events and typed results rather than in
 *   response parsing, and there is one place to look when asking what the client actually sends.
 */

import type { ChatRequest, ChatStreamEvent } from '../../chat';
import type { DescribeImageRequest, DescribeImageResponse } from '../../describe-image';
import type { CreateImageRequest, CreateImageResponse } from '../../images';
import type { RunMetrics } from '../../runs';
import { parseSseBuffer } from '../../sse';

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
