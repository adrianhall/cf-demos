/**
 * @file The Data Worker's private RPC entrypoint.
 *
 *   ## Shape of the contract
 *
 *   The grouped contract (`health`, `resolveActor`, `resolveUser`, `authorize`, plus `crm.*` and
 *   `permissions.*`) is exposed through **one** `WorkerEntrypoint` behind the one `DATA_SERVICE`
 *   binding. Module groups are methods returning an `RpcTarget` (`env.DATA_SERVICE.crm()`), not
 *   getters: Workers RPC does not let a caller invoke a method on a getter-returned target in one
 *   pipelined call, whereas a method call pipelines (`await env.DATA_SERVICE.crm().getContact(...)`
 *   is one round trip).
 *
 *   ## Errors as values
 *
 *   Every method resolves to an {@link RpcResult} envelope instead of throwing (see
 *   `src/shared/data-service/contract.ts`). Unexpected errors become a safe `INTERNAL` value; their
 *   detail is logged here and never sent to the caller.
 *
 *   ## Reachability
 *
 *   The Worker has no custom domain, no workers.dev route, and no preview URLs. `fetch()` answers
 *   404 to anything that somehow reaches it, so the binding is the only way in.
 */

import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import {
  createLogger,
  type Logger,
  resolveLoggerConfig
} from '@adrianhall/cloudflare-toolkit/logging';
import type {
  CreateCompanyInput,
  CreateContactInput,
  UpdateCompanyInput
} from '../shared/api/crm.ts';
import { isServiceError, serviceError, type ServiceErrorValue } from '../shared/common/errors.ts';
import type {
  ActorContext,
  AuthorizationDecision,
  AuthorizationRequest,
  CrmPort,
  DataHealth,
  DataService,
  Enveloped,
  ListOptions,
  MutationMeta,
  PermissionsPort,
  ResolvedActor,
  ResolvedUser,
  RpcResult
} from '../shared/data-service/contract.ts';
import { compose, type DataBindings } from './composition.ts';

/**
 * Build the Data Worker's structured logger for an environment.
 *
 * @param environment The `ENVIRONMENT` binding: absent in local development and production-like
 *   there, `test` under Vitest (silent), `production` when deployed.
 * @returns The logger.
 */
export function dataLogger(environment: string | undefined): Logger {
  return createLogger({
    ...resolveLoggerConfig(environment, 'worker'),
    bindings: { service: 'ignite-crm-data' }
  });
}

/**
 * Convert any thrown value into a safe service error value.
 *
 * @param error What was thrown.
 * @param operation Operation name for logging.
 * @param logger Receives the detail of unexpected failures.
 * @returns A structured-cloneable error value.
 */
export function toErrorValue(error: unknown, operation: string, logger: Logger): ServiceErrorValue {
  if (isServiceError(error)) {
    return {
      name: 'ServiceError',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId: error.requestId,
      ...(error.fields === undefined ? {} : { fields: { ...error.fields } })
    };
  }
  logger.error('unexpected Data Worker failure', {
    operation,
    error: error instanceof Error ? error.message : String(error)
  });
  const internal = serviceError('INTERNAL', 'An unexpected error occurred.');
  return {
    name: 'ServiceError',
    code: internal.code,
    message: internal.message,
    retryable: false,
    requestId: internal.requestId
  };
}

/**
 * Run an operation and wrap its outcome in an envelope, logging duration and outcome.
 *
 * @param logger Structured logger.
 * @param operation Operation name.
 * @param requestId Request identifier, when known.
 * @param work The operation.
 * @returns The envelope.
 */
export async function envelope<T>(
  logger: Logger,
  operation: string,
  requestId: string | undefined,
  work: () => Promise<T>
): Promise<RpcResult<T>> {
  const started = Date.now();
  try {
    const value = await work();
    logger.info('rpc', {
      module: operation.split('.')[0],
      operation,
      requestId,
      outcome: 'ok',
      durationMs: Date.now() - started
    });
    return { ok: true, value };
  } catch (error) {
    const value = toErrorValue(error, operation, logger);
    const withRequest =
      value.requestId === 'unknown' && requestId !== undefined ? { ...value, requestId } : value;
    logger.info('rpc', {
      module: operation.split('.')[0],
      operation,
      requestId,
      outcome: withRequest.code,
      durationMs: Date.now() - started
    });
    return { ok: false, error: withRequest };
  }
}

/**
 * Safe request id lookup on an untrusted actor argument.
 *
 * @param actor The actor argument.
 * @returns Its request id, if it has a string one.
 */
function requestIdOf(actor: unknown): string | undefined {
  const value = (actor as { requestId?: unknown } | null)?.requestId;
  return typeof value === 'string' ? value : undefined;
}

/**
 * CRM module RPC target.
 */
export class CrmRpc extends RpcTarget implements Enveloped<CrmPort> {
  /**
   * @param service The composed CRM service.
   * @param logger Structured logger.
   */
  constructor(
    private readonly service: CrmPort,
    private readonly logger: Logger
  ) {
    super();
  }

  /**
   * @inheritdoc
   */
  dashboard(actor: ActorContext) {
    return envelope(this.logger, 'crm.dashboard', requestIdOf(actor), () =>
      this.service.dashboard(actor)
    );
  }

  /**
   * @inheritdoc
   */
  listContacts(actor: ActorContext, options: ListOptions) {
    return envelope(this.logger, 'crm.listContacts', requestIdOf(actor), () =>
      this.service.listContacts(actor, options)
    );
  }

  /**
   * @inheritdoc
   */
  getContact(actor: ActorContext, id: string) {
    return envelope(this.logger, 'crm.getContact', requestIdOf(actor), () =>
      this.service.getContact(actor, id)
    );
  }

  /**
   * @inheritdoc
   */
  createContact(actor: ActorContext, input: CreateContactInput, meta: MutationMeta) {
    return envelope(this.logger, 'crm.createContact', requestIdOf(actor), () =>
      this.service.createContact(actor, input, meta)
    );
  }

  /**
   * @inheritdoc
   */
  listCompanies(actor: ActorContext, options: ListOptions) {
    return envelope(this.logger, 'crm.listCompanies', requestIdOf(actor), () =>
      this.service.listCompanies(actor, options)
    );
  }

  /**
   * @inheritdoc
   */
  getCompany(actor: ActorContext, id: string) {
    return envelope(this.logger, 'crm.getCompany', requestIdOf(actor), () =>
      this.service.getCompany(actor, id)
    );
  }

  /**
   * @inheritdoc
   */
  createCompany(actor: ActorContext, input: CreateCompanyInput, meta: MutationMeta) {
    return envelope(this.logger, 'crm.createCompany', requestIdOf(actor), () =>
      this.service.createCompany(actor, input, meta)
    );
  }

  /**
   * @inheritdoc
   */
  updateCompany(
    actor: ActorContext,
    id: string,
    input: UpdateCompanyInput,
    expectedVersion: number,
    meta: MutationMeta
  ) {
    return envelope(this.logger, 'crm.updateCompany', requestIdOf(actor), () =>
      this.service.updateCompany(actor, id, input, expectedVersion, meta)
    );
  }
}

/**
 * Permissions module RPC target.
 */
export class PermissionsRpc extends RpcTarget implements Enveloped<PermissionsPort> {
  /**
   * @param service The composed Permissions service.
   * @param logger Structured logger.
   */
  constructor(
    private readonly service: PermissionsPort,
    private readonly logger: Logger
  ) {
    super();
  }

  /**
   * @inheritdoc
   */
  getSession(actor: ActorContext) {
    return envelope(this.logger, 'permissions.getSession', requestIdOf(actor), () =>
      this.service.getSession(actor)
    );
  }
}

/**
 * The grouped Data Worker RPC entrypoint bound as `DATA_SERVICE`.
 */
export class DataEntrypoint extends WorkerEntrypoint<DataBindings> {
  /**
   * Build this invocation's composition.
   *
   * ES-private (`#`) rather than TypeScript `private`: Workers RPC exposes every prototype method
   * of a `WorkerEntrypoint`, and only `#` members are absent from the prototype.
   *
   * @returns The grouped service.
   */
  #service(): DataService {
    return compose(this.env);
  }

  /**
   * This invocation's logger (ES-private for the same reason as {@link #service}).
   *
   * @returns The logger.
   */
  #logger(): Logger {
    return dataLogger(this.env.ENVIRONMENT);
  }

  /**
   * Report Data Worker health.
   *
   * @returns The health envelope.
   */
  health(): Promise<RpcResult<DataHealth>> {
    return envelope(this.#logger(), 'data.health', undefined, () => this.#service().health());
  }

  /**
   * Resolve a verified e-mail to an active user.
   *
   * @param email Verified Access e-mail.
   * @param requestId Request identifier.
   * @returns The actor envelope.
   */
  resolveActor(email: string, requestId: string): Promise<RpcResult<ResolvedActor>> {
    return envelope(this.#logger(), 'permissions.resolveActor', requestId, () =>
      this.#service().resolveActor(email, requestId)
    );
  }

  /**
   * Look up a user by identifier.
   *
   * @param userId User identifier.
   * @returns The user envelope.
   */
  resolveUser(userId: string): Promise<RpcResult<ResolvedUser>> {
    return envelope(this.#logger(), 'permissions.resolveUser', undefined, () =>
      this.#service().resolveUser(userId)
    );
  }

  /**
   * Answer an authorization question.
   *
   * @param request The question.
   * @returns The decision envelope.
   */
  authorize(request: AuthorizationRequest): Promise<RpcResult<AuthorizationDecision>> {
    return envelope(this.#logger(), 'permissions.authorize', undefined, () =>
      this.#service().authorize(request)
    );
  }

  /**
   * The CRM module.
   *
   * @returns The CRM RPC target.
   */
  crm(): CrmRpc {
    return new CrmRpc(this.#service().crm, this.#logger());
  }

  /**
   * The Permissions module.
   *
   * @returns The Permissions RPC target.
   */
  permissions(): PermissionsRpc {
    return new PermissionsRpc(this.#service().permissions, this.#logger());
  }

  /**
   * Refuse HTTP. The Data Worker is RPC-only.
   *
   * @returns A 404 response.
   */
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
