import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { AppBindings } from '../bindings';

/**
 * FAQ knowledge-base API, mounted at `/api/faqs`.
 *
 * Every route is behind Cloudflare Access and reads its authorization subject from
 * `context.var.ACTOR`, which the composition root derives from the verified Access identity plus
 * D1. No route accepts an actor, role, clearance, or owner from the request, so a caller cannot
 * widen what they may read or manage by changing a field.
 *
 * The answer body is larger than the repository's 8 KiB default allows, so the limit is raised once
 * here to match {@link import('../domain/faq-validation')}'s documented maximum answer length rather
 * than per route.
 */
export const faqsRouter = new Hono<AppBindings>();

/**
 * Largest accepted FAQ payload.
 *
 * The domain bounds an answer at 8,000 characters and a question at 500. 32 KiB leaves room for
 * those as multi-byte UTF-8 plus the surrounding JSON, and still refuses a body that could only be
 * an attempt to use the knowledge base as storage.
 */
const MAX_FAQ_BODY_BYTES = 32_768;

faqsRouter.use(jsonBodyLimit(MAX_FAQ_BODY_BYTES));

/**
 * List FAQs.
 *
 * `?scope=manage` returns the manageable set — including archived and expired revisions — for a PM
 * or administrator. The default returns only what the caller may currently be answered from, which
 * is a different question and deliberately a different parameter rather than a status filter a
 * reader could widen.
 *
 * @param context Hono request context providing the actor and FAQ service.
 * @returns A JSON `200` response containing the visible FAQs.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {Error} When the repository cannot list FAQs.
 */
faqsRouter.get('/', async (context) => {
  const service = context.get('FAQ_SERVICE');
  const faqContext = context.get('FAQ_CONTEXT');
  const product = context.req.query('product');
  const faqs =
    context.req.query('scope') === 'manage'
      ? await service.listManageableFaqs(faqContext)
      : await service.listFaqs(faqContext, product);
  return context.json({ faqs });
});

/**
 * Read one FAQ.
 *
 * @param context Hono request context containing the `id` path parameter.
 * @returns A JSON `200` response containing the newest visible revision.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `notFound()` (404) when the identifier is malformed or unknown, or
 *   the FAQ is outside the reader's clearance, archived, or expired — all four answer identically
 *   so the endpoint cannot confirm a restricted answer exists.
 * @throws {Error} When the repository cannot read the FAQ.
 */
faqsRouter.get('/:id', async (context) => {
  const faq = await context
    .get('FAQ_SERVICE')
    .getFaq(context.get('FAQ_CONTEXT'), context.req.param('id'));
  return context.json({ faq });
});

/**
 * Publish a new FAQ.
 *
 * @param context Hono request context containing the bounded JSON body.
 * @returns A JSON `201` response containing the stored revision.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `400`/`422` for an invalid body, `403` when the product is not in
 *   the actor's scope, `404` when the actor has no management role.
 * @throws {Error} When the repository cannot store the revision.
 */
faqsRouter.post('/', async (context) => {
  const faq = await context
    .get('FAQ_SERVICE')
    .createFaq(context.get('FAQ_CONTEXT'), await readJsonBody(context.req.raw));
  // Identifiers and classification only. Question and answer text is exactly the content the
  // specification forbids in retained logs.
  context.get('LOGGER').info('faq_published', {
    faqId: faq.id,
    revision: faq.revision,
    audience: faq.audience,
    hasExpiry: faq.expiresAt !== null
  });
  return context.json({ faq }, 201);
});

/**
 * Publish a new revision of an existing FAQ.
 *
 * @param context Hono request context containing the `id` path parameter and bounded JSON body.
 * @returns A JSON `200` response containing the new revision.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `400`/`422` for an invalid body, `403` when the actor may manage
 *   knowledge but not this FAQ, `404` when the identifier is unknown or the actor has no management
 *   role.
 * @throws {Error} When the repository cannot read or write the FAQ.
 */
faqsRouter.patch('/:id', async (context) => {
  const faq = await context
    .get('FAQ_SERVICE')
    .updateFaq(
      context.get('FAQ_CONTEXT'),
      context.req.param('id'),
      await readJsonBody(context.req.raw)
    );
  context.get('LOGGER').info('faq_revised', {
    faqId: faq.id,
    revision: faq.revision,
    audience: faq.audience,
    status: faq.status
  });
  return context.json({ faq });
});

/**
 * Archive an FAQ.
 *
 * `204` rather than a body, and an archive rather than a row deletion: the revision history and the
 * audit trail stay, the search document is queued for removal, and retrieval stops returning the
 * entry immediately.
 *
 * @param context Hono request context containing the `id` path parameter.
 * @returns An empty `204` response once the archiving revision is durable.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `403` when the actor may manage knowledge but not this FAQ, `404`
 *   when the identifier is malformed or unknown or the actor has no management role.
 * @throws {Error} When the repository cannot read or write the FAQ.
 */
faqsRouter.delete('/:id', async (context) => {
  const faqId = context.req.param('id');
  await context.get('FAQ_SERVICE').deleteFaq(context.get('FAQ_CONTEXT'), faqId);
  context.get('LOGGER').info('faq_archived', { faqId });
  return new Response(null, { status: 204 });
});
