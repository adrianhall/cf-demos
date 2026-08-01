/**
 * @file Turns a `POST /api/chat` `Response` into an async sequence of typed
 * {@link ChatStreamFrame}s, built on the shared `src/sse.ts` decoder — see docs/05-AI-CHAT.md,
 * "Streaming Protocol". This is the **only** frame decoder on the client; nothing here re-parses
 * SSE framing that `src/sse.ts` already handles.
 */
import type { ChatStreamFrame } from "../../chat-protocol";
import { decodeSseStream } from "../../sse";

/** Content-Type prefix a successfully opened `/api/chat` stream always carries. */
const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

/**
 * Thrown when a `/api/chat` response is not a successfully opened event stream — most notably
 * the mid-conversation Cloudflare Access expiry case described in docs/05-AI-CHAT.md's "Access
 * Model": the browser's same-origin `fetch()` still reaches the Worker, but Access rejects it
 * with a `401` JSON body instead of an HTML redirect, before any stream ever opens.
 */
export class ChatResponseError extends Error {
  /** HTTP status of the rejected response. */
  readonly status: number;
  /** `true` for a `401`/`403`, the shape a lapsed Access session produces. */
  readonly sessionExpired: boolean;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ChatResponseError";
    this.status = status;
    this.sessionExpired = status === 401 || status === 403;
  }
}

/** Read a safe error message out of a non-stream response body, tolerating a non-JSON body. */
async function readErrorDetail(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "detail" in body &&
    typeof body.detail === "string"
  ) {
    return body.detail;
  }
  return `Request failed with status ${response.status}.`;
}

/**
 * Decode a `POST /api/chat` response into its typed {@link ChatStreamFrame} sequence.
 *
 * Checks the response's status and `Content-Type` **before** touching the body as SSE, per
 * docs/05-AI-CHAT.md's explicit requirement — attempting to decode a `401` JSON body as
 * event-stream frames would otherwise surface as a confusing parse failure instead of a clear
 * "your session expired" state.
 *
 * @param response The `fetch()` response for `POST /api/chat`.
 * @returns An async generator yielding each frame in order. Calling the generator's `return()`
 * (for example by `break`-ing a `for await` loop, as the chat store's Stop control does)
 * cancels the underlying reader, which cascades into the Worker's outgoing stream `cancel()`
 * handler and stops billable inference — see `src/worker/chat/stream.ts`.
 * @throws {ChatResponseError} When `response` did not successfully open an event stream (a
 * validation failure, an expired session, or any other non-streaming failure response).
 */
export async function* readChatStream(
  response: Response,
): AsyncGenerator<ChatStreamFrame, void, unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.startsWith(EVENT_STREAM_CONTENT_TYPE)) {
    throw new ChatResponseError(
      response.status,
      await readErrorDetail(response),
    );
  }
  if (response.body === null) {
    throw new ChatResponseError(
      response.status,
      "The response had no body to stream.",
    );
  }

  for await (const payload of decodeSseStream(response.body)) {
    yield JSON.parse(payload) as ChatStreamFrame;
  }
}
