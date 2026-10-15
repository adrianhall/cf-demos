import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { ActorResolver } from './application/actor-resolver';
import { AnswerService } from './application/answer-service';
import { AuditService } from './application/audit-service';
import { ConversationService } from './application/conversation-service';
import { DashboardService } from './application/dashboard-service';
import { DocumentationService } from './application/documentation-service';
import { EscalationService } from './application/escalation-service';
import { FaqService } from './application/faq-service';
import { IdentityService } from './application/identity-service';
import { IndexJobService } from './application/index-job-service';
import { ProductService } from './application/product-service';
import { RetrievalService } from './application/retrieval-service';
import type { AppBindings } from './bindings';
import { ConversationSession } from './infrastructure/conversation-session';
import { D1AuditRepository } from './infrastructure/d1-audit-repository';
import { D1ConversationRepository } from './infrastructure/d1-conversation-repository';
import { D1DashboardRepository } from './infrastructure/d1-dashboard-repository';
import { D1DocumentationRepository } from './infrastructure/d1-documentation-repository';
import { D1EscalationRepository } from './infrastructure/d1-escalation-repository';
import { D1FaqRepository } from './infrastructure/d1-faq-repository';
import { D1IdentityRepository } from './infrastructure/d1-identity-repository';
import { D1IndexJobRepository } from './infrastructure/d1-index-job-repository';
import { D1ProductRepository } from './infrastructure/d1-product-repository';
import { GatewayInferenceClient } from './infrastructure/gateway-inference-client';
import { createRetrieval, createSearchIndex } from './infrastructure/search-index-factory';
import { accessMiddleware } from './middleware/access';
import { adminRouter } from './routes/admin';
import { conversationsRouter } from './routes/conversations';
import { dashboardRouter } from './routes/dashboard';
import { escalationsRouter } from './routes/escalations';
import { faqsRouter } from './routes/faqs';
import { meRouter } from './routes/me';
import { productsRouter } from './routes/products';

/**
 * SalesBot Worker composition root.
 *
 * This is the only module that knows both the concrete D1 and AI Search adapters and the
 * application services. Routes receive services ready-made and never construct a repository, which
 * is what keeps the UI → API → application → infrastructure dependency direction one-way: nothing
 * in `routes/` imports from `infrastructure/`.
 */
/**
 * Durable Object class exported by this Worker's entry module.
 */
export { ConversationSession };

const app = new Hono<AppBindings>();
app.use(cloudflareLogger());
app.get('/health', (context) => context.json({ status: 'ok' }));
app.use(accessMiddleware);

/**
 * Build the request-scoped services and the authorization subject.
 *
 * The actor is resolved once per request rather than per route. Resolving it here means every route
 * sees the same subject — the same role, clearance, and product scope evaluated against the same
 * instant — so two checks within one request cannot disagree because the product map changed
 * between them.
 *
 * `NOW` is captured once for the same reason. Validation, the 90-day expiry default, the expiry
 * check on read, and the audit timestamp all read it, and a request in which those differ by
 * milliseconds is a request whose behaviour is not reproducible in a test.
 *
 * @param context Hono request context supplying the `DB` binding and verified identity.
 * @param next Middleware continuation invoked after the services are attached.
 * @returns A promise fulfilled after the downstream middleware and selected route finish.
 * @throws {NullError} When the Access middleware did not verify an identity.
 * @throws {Error} When D1 cannot resolve the identity or its product scope.
 */
app.use(async (context, next) => {
  const database = context.env.DB;
  const faqs = new D1FaqRepository(database);
  const products = new D1ProductRepository(database);
  const audit = new D1AuditRepository(database);
  const indexJobs = new D1IndexJobRepository(database);
  const identities = new D1IdentityRepository(database);
  const conversations = new D1ConversationRepository(database);
  const searchIndex = createSearchIndex(context.env, import.meta.env.DEV);

  const now = new Date();
  const actor = await new ActorResolver(identities, products).resolve(
    context.get('Cloudflare_Access_Identity').email,
    now
  );
  const correlationId = context.req.header('cf-ray') ?? crypto.randomUUID();

  context.set('IDENTITY_SERVICE', new IdentityService(identities));
  context.set('ACTOR', actor);
  context.set('NOW', now);
  context.set('CORRELATION_ID', correlationId);
  context.set('FAQ_CONTEXT', { actor, correlationId, now });
  context.set('FAQ_SERVICE', new FaqService(faqs, indexJobs, audit));
  context.set('CONVERSATION_SERVICE', new ConversationService(conversations, audit));
  context.set(
    'ESCALATION_SERVICE',
    new EscalationService(
      new D1EscalationRepository(database),
      conversations,
      faqs,
      indexJobs,
      audit
    )
  );
  context.set(
    'RETRIEVAL_SERVICE',
    new RetrievalService(createRetrieval(context.env, import.meta.env.DEV), faqs)
  );
  context.set(
    'ANSWER_SERVICE',
    new AnswerService(
      context.get('RETRIEVAL_SERVICE'),
      new GatewayInferenceClient({
        ai: context.env.AI,
        gatewayId: context.env.AI_GATEWAY_ID,
        logger: context.get('LOGGER')
      }),
      conversations,
      new D1EscalationRepository(database),
      products,
      audit,
      context.get('LOGGER')
    )
  );
  context.set('PRODUCT_SERVICE', new ProductService(products));
  context.set(
    'DOCUMENTATION_SERVICE',
    new DocumentationService(new D1DocumentationRepository(database), audit)
  );
  context.set('INDEX_JOB_SERVICE', new IndexJobService(indexJobs, faqs, searchIndex, audit));
  context.set('AUDIT_SERVICE', new AuditService(audit));
  context.set('DASHBOARD_SERVICE', new DashboardService(new D1DashboardRepository(database)));
  await next();
});

app.route('/api/me', meRouter);
app.route('/api/conversations', conversationsRouter);
app.route('/api/escalations', escalationsRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/products', productsRouter);
app.route('/api/faqs', faqsRouter);
app.route('/api/admin', adminRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
// in a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
