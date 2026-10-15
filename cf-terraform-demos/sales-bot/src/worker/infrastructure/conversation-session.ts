import { DurableObject } from 'cloudflare:workers';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { NOT_OWNER_CLOSE_CODE, type ServerFrame } from '../../chat-protocol';
import { AnswerService } from '../application/answer-service';
import { ConversationService } from '../application/conversation-service';
import { RetrievalService } from '../application/retrieval-service';
import type { Actor } from '../domain/actor';
import type { Conversation } from '../domain/conversation';
import { validateClientFrame } from '../domain/conversation-validation';
import { D1AuditRepository } from './d1-audit-repository';
import { D1ConversationRepository } from './d1-conversation-repository';
import { D1EscalationRepository } from './d1-escalation-repository';
import { D1FaqRepository } from './d1-faq-repository';
import { D1ProductRepository } from './d1-product-repository';
import { GatewayInferenceClient, isAbortError } from './gateway-inference-client';
import { createRetrieval, type SearchIndexEnv } from './search-index-factory';
import { readVerifiedIdentity, type VerifiedSessionIdentity } from './session-protocol';

/**
 * A connection attachment that survives WebSocket hibernation.
 */
interface SocketAttachment {
  /**
   * Verified identity pinned at upgrade time.
   */
  identity: VerifiedSessionIdentity;
}

/**
 * Services a session composes from bindings.
 *
 * A Durable Object is its own execution entry point, so it cannot receive the top-level Worker's
 * request-scoped Hono values. It composes the same four tiers here from the same bindings instead:
 * D1 remains authoritative, the gateway client remains the only AI binding caller, and the session
 * only coordinates ordering and sockets.
 */
interface SessionServices {
  /**
   * Conversation ownership, transcript replay, and idempotent question writes.
   */
  conversations: ConversationService;
  /**
   * Shared retrieval, decision, generation, and escalation workflow.
   */
  answers: AnswerService;
}

/**
 * Converts a verified header identity into the domain actor used by services.
 */
function toActor(identity: VerifiedSessionIdentity): Actor {
  const clearance = identity.clearance;
  if (
    clearance !== 'public'
    && clearance !== 'customer'
    && clearance !== 'nda'
    && clearance !== 'internal'
  ) {
    throw new Error('Session received an invalid verified clearance.');
  }
  const role = identity.role;
  if (role !== 'salesperson' && role !== 'pm' && role !== 'overseer' && role !== 'administrator') {
    throw new Error('Session received an invalid verified role.');
  }
  return {
    identityKey: identity.identityKey,
    email: identity.email,
    clearance,
    role,
    productScopes: []
  };
}

/**
 * Sends a frame only while its socket remains open.
 */
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

/**
 * Extracts an RFC 9457-safe detail from an arbitrary failure.
 */
function safeDetail(cause: unknown): string {
  if (cause instanceof ProblemDetailsError) {
    return cause.problemDetails.detail ?? 'The request could not be completed.';
  }
  return 'The request could not be completed. Try again or ask for a product manager.';
}

/**
 * One web conversation's ordered coordination point and live WebSocket delivery.
 *
 * D1 remains authoritative: this object stores no transcript, only a cancellation controller in
 * memory. A controller need not survive hibernation because an evicted object has no active model
 * call; identities do need to survive, so each socket carries one serialized attachment. Every turn
 * is written to D1 by the service before this object broadcasts it, and a reconnect receives D1's
 * transcript first.
 */
export class ConversationSession extends DurableObject<Env> {
  /**
   * Cancellation controller for an in-flight generation, if any.
   */
  private activeAbort: AbortController | null = null;

  /**
   * Accept an authenticated connection and replay its transcript.
   *
   * This must be `fetch`, not RPC: a live WebSocket cannot cross RPC serialization and hibernation
   * completes the protocol switch against this exact request. The session trusts its identity
   * headers only because it has no public route and `withVerifiedIdentity()` scrubbed and replaced
   * them in the authenticated Worker before forwarding.
   *
   * @param request Upgrade request forwarded by the Worker.
   * @returns A switching-protocols response or a clear rejection for a malformed direct call.
   */
  public async fetch(request: Request): Promise<Response> {
    const identity = readVerifiedIdentity(request);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || identity === null) {
      return new Response('Expected an identified WebSocket upgrade.', { status: 400 });
    }

    const actor = toActor(identity);
    const conversationId = this.conversationId();
    const services = this.services();
    try {
      await services.conversations.requireOwned(this.context(actor, identity), conversationId);
    } catch {
      return new Response('Conversation not found.', { status: 404 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ identity } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    send(server, {
      type: 'transcript',
      turns: await services.conversations.listTurns(this.context(actor, identity), conversationId)
    });
    send(server, { type: 'status', stage: 'idle' });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Persist and answer one submitted frame.
   *
   * @param socket Sender carrying its hibernation-safe identity attachment.
   * @param message JSON text frame; binary frames are rejected safely.
   * @returns A promise fulfilled after a durable turn has been broadcast, or after the sender has a
   *   safe rejection. Persistence always precedes broadcast.
   */
  public async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) {
      socket.close(1011, 'Connection is missing its identity.');
      return;
    }
    if (typeof message !== 'string') {
      send(socket, { type: 'error', detail: 'Messages must be text frames.' });
      return;
    }

    let frame;
    try {
      frame = validateClientFrame(JSON.parse(message));
    } catch (cause: unknown) {
      send(socket, { type: 'error', detail: safeDetail(cause) });
      return;
    }

    if (frame.type === 'cancel') {
      this.activeAbort?.abort();
      send(socket, { type: 'status', stage: 'idle' });
      return;
    }

    const actor = toActor(attachment.identity);
    const services = this.services();
    let conversation: Conversation;
    try {
      conversation = await services.conversations.requireOwned(
        this.context(actor, attachment.identity),
        this.conversationId()
      );
    } catch {
      socket.close(NOT_OWNER_CLOSE_CODE, 'Conversation not found.');
      return;
    }

    if (frame.type === 'escalate') {
      const turns = await services.conversations.listTurns(
        this.context(actor, attachment.identity),
        conversation.id
      );
      const question = [...turns].reverse().find((turn) => turn.kind === 'question');
      if (question === undefined) {
        send(socket, { type: 'error', detail: 'Ask a question before requesting escalation.' });
        return;
      }
      const outcome = await services.answers.escalateOnRequest(
        this.context(actor, attachment.identity),
        conversation,
        question
      );
      this.broadcast({ type: 'turn', turn: outcome.turn });
      return;
    }

    const recorded = await services.conversations.recordQuestion(
      this.context(actor, attachment.identity),
      conversation,
      frame.question,
      frame.idempotencyKey
    );
    if (!recorded.created) {
      // A retry is already durable and the reconnect transcript is authoritative. Replay this one
      // turn for a same-socket retry, but never run a second model workflow.
      send(socket, { type: 'turn', turn: recorded.turn });
      return;
    }

    this.broadcast({ type: 'turn', turn: recorded.turn });
    this.activeAbort?.abort();
    const abort = new AbortController();
    this.activeAbort = abort;
    this.broadcast({ type: 'status', stage: 'retrieving' });
    try {
      const outcome = await services.answers.answer(
        { ...this.context(actor, attachment.identity), signal: abort.signal },
        conversation,
        recorded.turn,
        (stage) => this.broadcast({ type: 'status', stage })
      );
      if (!abort.signal.aborted) {
        this.broadcast({ type: 'turn', turn: outcome.turn });
      }
    } catch (cause: unknown) {
      if (!isAbortError(cause)) {
        send(socket, { type: 'error', detail: safeDetail(cause) });
      }
    } finally {
      if (this.activeAbort === abort) {
        this.activeAbort = null;
      }
      this.broadcast({ type: 'status', stage: 'idle' });
    }
  }

  /**
   * Closes an in-flight model call when its initiating connection departs.
   */
  public webSocketClose(_socket: WebSocket, _code: number, _reason: string): void {
    if (this.ctx.getWebSockets().length === 0) {
      this.activeAbort?.abort();
    }
  }

  /**
   * Handles an errored socket like a clean close.
   */
  public webSocketError(_socket: WebSocket, _error: unknown): void {
    if (this.ctx.getWebSockets().length === 0) {
      this.activeAbort?.abort();
    }
  }

  /**
   * Read the Durable Object name, which is the stable conversation identifier.
   *
   * @returns The conversation identifier used to address this session.
   * @throws {Error} When a session was not addressed by name, which is a deployment/programming
   *   fault: this Worker only ever uses `getByName(conversationId)`.
   */
  private conversationId(): string {
    if (this.ctx.id.name === undefined) {
      throw new Error('ConversationSession must be addressed by its conversation identifier.');
    }
    return this.ctx.id.name;
  }

  /**
   * Build request values from a pinned verified identity.
   */
  private context(
    actor: Actor,
    identity: VerifiedSessionIdentity
  ): { actor: Actor; correlationId: string; now: Date } {
    return { actor, correlationId: identity.correlationId, now: new Date() };
  }

  /**
   * Compose object-local services from the same concrete adapters the HTTP Worker uses.
   *
   * The session is intentionally not a second source of truth: all its durable work is delegated to
   * D1 repositories, and the only model client it can construct is GatewayInferenceClient. A
   * request-scoped logger is unavailable in a Durable Object hibernation callback, so the answer
   * service's optional logger is omitted here; gateway/provider failures still surface safely to
   * the socket and the gateway itself records the correlation metadata.
   *
   * @returns Conversation and answer services ready for one socket event.
   */
  private services(): SessionServices {
    const conversations = new D1ConversationRepository(this.env.DB);
    const faqs = new D1FaqRepository(this.env.DB);
    const products = new D1ProductRepository(this.env.DB);
    const audit = new D1AuditRepository(this.env.DB);
    return {
      conversations: new ConversationService(conversations, audit),
      answers: new AnswerService(
        new RetrievalService(
          createRetrieval(this.env as SearchIndexEnv, import.meta.env.DEV),
          faqs
        ),
        new GatewayInferenceClient({ ai: this.env.AI, gatewayId: this.env.AI_GATEWAY_ID }),
        conversations,
        new D1EscalationRepository(this.env.DB),
        products,
        audit
      )
    };
  }

  /**
   * Broadcast a frame after its corresponding turn is already durable.
   */
  private broadcast(frame: ServerFrame): void {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, frame);
    }
  }
}
