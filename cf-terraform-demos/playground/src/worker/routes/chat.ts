import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { ChatCompletedEvent, ChatProblemEvent, ChatStreamEvent } from '../../shared/chat';
import type { AppBindings } from '../bindings';
import { validateChatRequest, type ValidatedChatRequest } from '../domain/chat';

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
 * Describes a Chat attempt for the log, carrying shape rather than content.
 *
 * Turn count and total character count are recorded instead of the conversation: the messages are
 * the visitor's content, while the counts still distinguish a real request from an empty-looking
 * one and explain a token charge that looks surprising. The bounded sampling controls are named
 * only when the caller set them, because "the caller chose a temperature" and "the model default
 * applied" are different facts and a log that printed a default for both could not tell them
 * apart.
 *
 * @param request The validated Chat request.
 * @returns Log fields describing the attempt, free of prompt text.
 */
function describeAttempt(request: ValidatedChatRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    turnCount: request.messages.length,
    // Spread rather than `.length`, so an astral-plane character counts once rather than twice and
    // the figure matches what the domain's own limit counted.
    characterCount: request.messages.reduce((total, turn) => total + [...turn.content].length, 0),
    requestedControls: [
      ...(request.temperature === undefined ? [] : ['temperature']),
      ...(request.maxTokens === undefined ? [] : ['maxTokens'])
    ],
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens })
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

  // Logged before the model is called, not only after. Chat is the panel where this matters most:
  // it is the only one that streams, so a connection dropped halfway through an answer ends the
  // request without reaching either terminal log line. Without this, the one panel most likely to
  // fail mid-flight would be the one leaving no record of what it attempted.
  logger.info('chat_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

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
      // The attempt shape is repeated here rather than left to be joined against the start line.
      // A failure is the line someone reads first, and making it self-contained means the
      // parameters are present even when the start line has aged out of the retention window.
      logger.warn('chat_run_failed', {
        runId: request.runId,
        status: problem.status,
        ...describeAttempt(request),
        // The provider's own description of what went wrong, which the visitor-facing event
        // deliberately replaces with generic wording. Sanitising for the browser and discarding
        // the cause are different things, and only the first is wanted.
        errorName: cause instanceof Error ? cause.name : typeof cause,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
        cause:
          cause instanceof Error && cause.cause instanceof Error
            ? `${cause.cause.name}: ${cause.cause.message}`
            : undefined
      });
      await send(problem);
    }
  });
});
