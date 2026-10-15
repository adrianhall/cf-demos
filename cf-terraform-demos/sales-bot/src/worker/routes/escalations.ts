import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { AppBindings } from '../bindings';

/**
 * PM and administrator escalation-queue API.
 */
export const escalationsRouter = new Hono<AppBindings>();
escalationsRouter.use(jsonBodyLimit(32_768));
/**
 * List the actor's in-scope queue.
 */
escalationsRouter.get('/', async (context) =>
  context.json({
    escalations: await context.get('ESCALATION_SERVICE').list({
      actor: context.get('ACTOR'),
      correlationId: context.get('CORRELATION_ID'),
      now: context.get('NOW')
    })
  })
);
/**
 * Reassign an escalation.
 */
escalationsRouter.post('/:id/reassign', async (context) => {
  const body = await readJsonBody(context.req.raw);
  const target =
    typeof body === 'object'
    && body !== null
    && typeof (body as Record<string, unknown>).target === 'string'
      ? (body as Record<string, string>).target
      : '';
  return context.json({
    escalation: await context.get('ESCALATION_SERVICE').reassign(
      {
        actor: context.get('ACTOR'),
        correlationId: context.get('CORRELATION_ID'),
        now: context.get('NOW')
      },
      context.req.param('id'),
      target
    )
  });
});
/**
 * Answer and optionally publish a FAQ.
 */
escalationsRouter.post('/:id/answer', async (context) => {
  const body = await readJsonBody(context.req.raw);
  if (typeof body !== 'object' || body === null) throw new Error('Expected a JSON object.');
  const input = body as {
    answer?: unknown;
    publishFaq?: unknown;
    audience?: unknown;
    expiresAt?: unknown;
  };
  const answer = typeof input.answer === 'string' ? input.answer : '';
  const publishFaq = input.publishFaq === true;
  const audience =
    input.audience === 'public'
    || input.audience === 'customer'
    || input.audience === 'nda'
    || input.audience === 'internal'
      ? input.audience
      : undefined;
  const expiresAt =
    input.expiresAt === null || typeof input.expiresAt === 'string' ? input.expiresAt : undefined;
  return context.json({
    turn: await context.get('ESCALATION_SERVICE').answer(
      {
        actor: context.get('ACTOR'),
        correlationId: context.get('CORRELATION_ID'),
        now: context.get('NOW')
      },
      context.req.param('id'),
      { answer, publishFaq, audience, expiresAt }
    )
  });
});
/**
 * Reject an escalation and notify its requester in the original conversation.
 */
escalationsRouter.post('/:id/close', async (context) => {
  const body = await readJsonBody(context.req.raw);
  const reason =
    typeof body === 'object'
    && body !== null
    && typeof (body as Record<string, unknown>).reason === 'string'
      ? (body as Record<string, string>).reason
      : '';
  return context.json({
    turn: await context.get('ESCALATION_SERVICE').reject(
      {
        actor: context.get('ACTOR'),
        correlationId: context.get('CORRELATION_ID'),
        now: context.get('NOW')
      },
      context.req.param('id'),
      reason
    )
  });
});
