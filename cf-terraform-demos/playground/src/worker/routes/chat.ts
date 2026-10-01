import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { ChatCompletedEvent, ChatProblemEvent, ChatStreamEvent } from '../../chat';
import type { AppBindings } from '../bindings';
import { validateChatRequest } from '../domain/chat';

/**
 * Largest Chat request body accepted.
 *
 * Larger than the shared 8 KiB default because this endpoint has a documented payload contract: up
 * to 20 turns of up to 8,000 characters each. The limit still exists, and it is enforced before the
 * body is parsed so an oversized request is refused without being buffered.
 */
export const CHAT_BODY_LIMIT_BYTES = 262_144;

/**
 * Chat's server-sent events endpoint, mounted at `/api/chat/stream`.
 *
 * `POST` rather than `GET`, which rules out `EventSource` on the client and is the right trade: a
 * prompt belongs in a request body, not in a URL that ends up in browser history, proxy logs, and
 * referrer headers.
 *
 * Every failure is delivered as a typed `problem` event inside the stream once streaming has begun.
 * Switching to an HTTP error status mid-response is not possible — the status is already sent — and
 * simply closing the stream would be indistinguishable from a dropped connection. Failures detected
 * _before_ streaming starts are ordinary problem-details responses, because at that point a status
 * is still available.
 */
export const chatRouter = new Hono<AppBindings>();

chatRouter.use(jsonBodyLimit(CHAT_BODY_LIMIT_BYTES));

/**
 * Converts a thrown error into the stream's `problem` event payload.
 *
 * A `ProblemDetailsError` already carries a message written for a visitor, so it is used as-is.
 * Anything else is replaced with a generic message: an unexpected error's text is written for a
 * developer and can name internals, and the Worker's structured log is where it belongs.
 *
 * @param cause The thrown value, of unknown type.
 * @returns The problem event to send.
 */
function toProblemEvent(cause: unknown): ChatProblemEvent {
  if (cause instanceof ProblemDetailsError) {
    const problem = cause.problemDetails;
    return {
      type: 'problem',
      status: problem.status,
      title: problem.title ?? 'The request failed',
      detail: problem.detail ?? 'The request could not be completed.'
    };
  }

  return {
    type: 'problem',
    status: 500,
    title: 'The request failed',
    detail: 'Something went wrong while generating the answer. Try again.'
  };
}

/**
 * Streams a Chat answer as typed server-sent events.
 *
 * The event order is `start`, zero or more `delta`, then exactly one of `completed` or `problem`.
 * The browser relies on that terminal event: its absence means the connection dropped, which is a
 * different situation from a reported failure and is shown differently.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Chat service.
 * @returns An SSE response. The validation and authorization failures that happen before the first
 *   byte are thrown instead, so they reach the client as RFC 9457 problem documents with a real
 *   status code.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, or fails Chat validation; `502` when the provider fails before the stream
 *   opens.
 */
chatRouter.post('/stream', async (context) => {
  // Validation runs before the stream opens, so a bad request still gets a 400 with a problem
  // document rather than a 200 whose body happens to contain an error event.
  const request = validateChatRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // The actor is assembled here from the verified JWT claims alone. There is no code path by which
  // a body or header value could reach it, which is why the domain rejects a body that carries one
  // rather than relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;
  const service = context.var.CHAT_SERVICE;

  const run = await service.streamChat(request, actor);

  return streamSSE(context, async (stream) => {
    /**
     * Writes one typed event to the stream.
     *
     * @param event The event to send; its `type` is also the SSE event name, so the two cannot
     *   disagree.
     * @returns A promise fulfilled once the frame has been written.
     */
    const send = async (event: ChatStreamEvent): Promise<void> => {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    };

    try {
      await send({ type: 'start', runId: request.runId, model: request.model.id });

      for await (const text of run.chunks) {
        await send({ type: 'delta', text });
      }

      const completed: ChatCompletedEvent = { type: 'completed', receipt: await run.complete() };
      await send(completed);

      // Deliberately free of prompt text, answer text, and the user's email. The email is recorded
      // in AI Gateway metadata and nowhere else; a structured log is a different retention domain
      // with different access control.
      logger.info('chat_run_completed', {
        runId: completed.receipt.runId,
        model: completed.receipt.model,
        elapsedMs: completed.receipt.elapsedMs,
        costStatus: completed.receipt.costStatus,
        logCount: completed.receipt.logIds.length
      });
    } catch (cause) {
      const problem = toProblemEvent(cause);
      logger.warn('chat_run_failed', {
        runId: request.runId,
        model: request.model.id,
        status: problem.status
      });
      await send(problem);
    }
  });
});
