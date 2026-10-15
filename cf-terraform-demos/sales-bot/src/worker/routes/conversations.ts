import { Hono } from 'hono';
import {
  currentIdentity,
  jsonBodyLimit,
  readJsonBody,
  upgradeRequired
} from '@demos/worker-common';
import type { AppBindings } from '../bindings';
import { validateAskInput } from '../domain/conversation-validation';
import { D1RateLimiter } from '../infrastructure/d1-rate-limiter';
import { DurableConversationSessions } from '../infrastructure/durable-conversation-sessions';

/**
 * API for an authenticated requester's own web conversations.
 */
export const conversationsRouter = new Hono<AppBindings>();
conversationsRouter.use(jsonBodyLimit());

/**
 * Creates a new conversation owned by the verified requester.
 */
conversationsRouter.post('/', async (context) => {
  const conversation = await context.get('CONVERSATION_SERVICE').createConversation({
    actor: context.get('ACTOR'),
    correlationId: context.get('CORRELATION_ID'),
    now: context.get('NOW')
  });
  return context.json({ conversation }, 201);
});

/**
 * Lists only conversations owned by the verified requester.
 */
conversationsRouter.get('/', async (context) =>
  context.json({
    conversations: await context.get('CONVERSATION_SERVICE').listConversations({
      actor: context.get('ACTOR'),
      correlationId: context.get('CORRELATION_ID'),
      now: context.get('NOW')
    })
  })
);

/**
 * Replays a requester's authoritative D1 transcript.
 */
conversationsRouter.get('/:id/events', async (context) =>
  context.json({
    turns: await context.get('CONVERSATION_SERVICE').listTurns(
      {
        actor: context.get('ACTOR'),
        correlationId: context.get('CORRELATION_ID'),
        now: context.get('NOW')
      },
      context.req.param('id')
    )
  })
);

/**
 * Posts one question over HTTP for clients that cannot keep a WebSocket open.
 */
conversationsRouter.post('/:id/messages', async (context) => {
  await new D1RateLimiter(context.env.DB).consume(
    context.get('ACTOR').identityKey,
    'message',
    context.get('NOW')
  );
  const conversation = await context.get('CONVERSATION_SERVICE').requireOwned(
    {
      actor: context.get('ACTOR'),
      correlationId: context.get('CORRELATION_ID'),
      now: context.get('NOW')
    },
    context.req.param('id')
  );
  const input = validateAskInput(await readJsonBody(context.req.raw));
  const recorded = await context.get('CONVERSATION_SERVICE').recordQuestion(
    {
      actor: context.get('ACTOR'),
      correlationId: context.get('CORRELATION_ID'),
      now: context.get('NOW')
    },
    conversation,
    input.question,
    input.idempotencyKey
  );
  return context.json(
    { turn: recorded.turn, created: recorded.created },
    recorded.created ? 201 : 200
  );
});

/**
 * Forwards the authenticated WebSocket upgrade to the durable session.
 */
conversationsRouter.get('/:id/stream', async (context) => {
  if (context.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw upgradeRequired('This endpoint accepts WebSocket connections only.');
  }
  const conversation = await context.get('CONVERSATION_SERVICE').requireOwned(
    {
      actor: context.get('ACTOR'),
      correlationId: context.get('CORRELATION_ID'),
      now: context.get('NOW')
    },
    context.req.param('id')
  );
  const identity = currentIdentity(context);
  return new DurableConversationSessions(context.env.CONVERSATION_SESSION).join(
    conversation.id,
    context.req.raw,
    {
      identityKey: context.get('ACTOR').identityKey,
      email: identity.email,
      clearance: context.get('ACTOR').clearance,
      role: context.get('ACTOR').role,
      correlationId: context.get('CORRELATION_ID')
    }
  );
});
