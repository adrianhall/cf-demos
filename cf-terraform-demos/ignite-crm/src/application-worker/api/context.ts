/**
 * @file Hono environment types and per-request context helpers for the API module.
 */

import type { Context } from 'hono';
import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import { currentIdentityEmail } from '@demos/worker-common';
import type { ActorContext, DataService } from '../../shared/data-service/contract.ts';

/**
 * Bindings the API module reads. A subset of the generated `Env`, so tests can supply only these.
 */
export interface ApiBindings {
  /**
   * Access Application Audience tag.
   */
  readonly ACCESS_AUD: string;
  /**
   * Deployment environment name; absent in development.
   */
  readonly ENVIRONMENT?: string;
  /**
   * Durable Object namespace for chat sessions.
   */
  readonly CHAT_AGENT: DurableObjectNamespace;
  /**
   * Account-authenticated Workers AI binding.
   */
  readonly AI: Ai;
  /**
   * Chat model selected by deployment configuration.
   */
  readonly AI_CHAT_MODEL?: string;
  /**
   * Data Worker RPC service binding.
   */
  readonly DATA_SERVICE: Env['DATA_SERVICE'];
}

/**
 * Variables set on the Hono context during a request.
 */
export interface ApiVariables extends CloudflareToolkitVariables {
  /**
   * Request identifier, echoed as `X-Request-Id`.
   */
  requestId: string;
  /**
   * The data service for this request.
   */
  data: DataService;
  /**
   * The resolved actor, cached after the first {@link actorOf} call.
   */
  actor?: ActorContext;
}

/**
 * The API module's Hono environment.
 */
export interface ApiEnv {
  /**
   * Worker bindings.
   */
  Bindings: ApiBindings;
  /**
   * Request-scoped variables.
   */
  Variables: ApiVariables;
}

/**
 * The API's Hono context.
 */
export type ApiContext = Context<ApiEnv>;

/**
 * Resolve, once per request, the actor for the verified Access identity.
 *
 * The e-mail comes only from the Access middleware's verified JWT (never from a header, query, or
 * body), and the Data Worker maps it to an installation user. Resolution is lazy so routes that
 * need no actor — health, configuration — do not provision a user as a side effect.
 *
 * @param context The request context.
 * @returns The actor.
 * @throws {Error} The Data Worker's `FORBIDDEN` (inactive account) or `DEPENDENCY_FAILURE` error.
 */
export async function actorOf(context: ApiContext): Promise<ActorContext> {
  const cached = context.get('actor');
  if (cached !== undefined) {
    return cached;
  }
  const requestId = context.get('requestId');
  const resolved = await context.get('data').resolveActor(currentIdentityEmail(context), requestId);
  const actor: ActorContext = {
    email: resolved.email,
    userId: resolved.userId,
    requestId,
    channel: 'api'
  };
  context.set('actor', actor);
  return actor;
}
