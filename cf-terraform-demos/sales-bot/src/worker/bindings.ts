import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { AnswerService } from './application/answer-service';
import type { AuditService } from './application/audit-service';
import type { ConversationService } from './application/conversation-service';
import type { DocumentationService } from './application/documentation-service';
import type { EscalationService } from './application/escalation-service';
import type { FaqContext, FaqService } from './application/faq-service';
import type { IdentityService } from './application/identity-service';
import type { IndexJobService } from './application/index-job-service';
import type { ProductService } from './application/product-service';
import type { RetrievalService } from './application/retrieval-service';
import type { Actor } from './domain/actor';
import type { ConversationSession } from './infrastructure/conversation-session';
import type { SearchIndexEnv } from './infrastructure/search-index-factory';

/**
 * Request values added by SalesBot middleware.
 *
 * Services are attached per request by the composition root, so no route constructs a repository
 * and nothing in `routes/` imports from `infrastructure/`. The actor, correlation identifier, and
 * instant are attached alongside them so that every tier of one request agrees about who is acting,
 * which request this is, and what "now" means.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Application service supplied by the composition root.
   */
  IDENTITY_SERVICE: IdentityService;
  /**
   * Authorization subject derived from the verified Access identity and D1. Never from the request
   * itself.
   */
  ACTOR: Actor;
  /**
   * Identifier shared by every log line and audit entry for this request.
   */
  CORRELATION_ID: string;
  /**
   * Instant this request is evaluated at, so validation, expiry, and timestamps agree within one
   * request rather than drifting between calls to `new Date()`.
   */
  NOW: Date;
  /**
   * Actor, correlation identifier, and instant bundled for the FAQ service, which needs all three
   * on every operation.
   */
  FAQ_CONTEXT: FaqContext;
  /**
   * FAQ knowledge-base use cases.
   */
  FAQ_SERVICE: FaqService;
  /**
   * Conversation ownership, transcript replay, and idempotent question writes.
   */
  CONVERSATION_SERVICE: ConversationService;
  /**
   * PM escalation actions, delivery, and optional FAQ publication.
   */
  ESCALATION_SERVICE: EscalationService;
  /**
   * Retrieval with authoritative D1 policy rechecks.
   */
  RETRIEVAL_SERVICE: RetrievalService;
  /**
   * Shared gateway-routed answer and escalation workflow.
   */
  ANSWER_SERVICE: AnswerService;
  /**
   * Product-map use cases.
   */
  PRODUCT_SERVICE: ProductService;
  /**
   * Approved-documentation import and inspection.
   */
  DOCUMENTATION_SERVICE: DocumentationService;
  /**
   * Retryable search-index work and the administrator freshness view.
   */
  INDEX_JOB_SERVICE: IndexJobService;
  /**
   * Audit-trail reads.
   */
  AUDIT_SERVICE: AuditService;
}

/**
 * Hono binding and request-variable types for the Worker.
 */
export interface AppBindings {
  /**
   * Generated environment bindings, plus the optional production label and the optional AI Search
   * instance.
   *
   * `AI_SEARCH` comes from {@link SearchIndexEnv} rather than from the generated types because
   * Terraform does not provision an instance yet; see
   * `src/worker/infrastructure/ai-search-index.ts` for why that is deliberate. Declaring it
   * optional here is what lets the indexing pipeline be built and tested before the instance
   * exists.
   */
  Bindings: Omit<Env, 'CONVERSATION_SESSION'>
    & SearchIndexEnv & {
      /**
       * Self-referential namespace coordinating one web conversation per Durable Object.
       */
      CONVERSATION_SESSION: DurableObjectNamespace<ConversationSession>;
      /**
       * Omitted locally, explicitly labelled in production.
       */
      ENVIRONMENT?: string;
    };
  /**
   * Values set during request processing.
   */
  Variables: AppVariables;
}
