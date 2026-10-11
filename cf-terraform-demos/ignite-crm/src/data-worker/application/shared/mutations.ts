/**
 * @file Audit and idempotency support shared by every mutating use case (specification §5.3). A
 *   mutation produces a {@link MutationEnvelope} — its audit events plus the idempotency record
 *   holding its result — which the repository commits in the same atomic write set as the business
 *   change. Either all of it is stored or none of it is.
 */

import { serviceError } from '../../../shared/common/errors.ts';
import type { ActorContext, MutationMeta } from '../../../shared/data-service/contract.ts';
import type { Runtime } from './runtime.ts';

/**
 * How long an idempotency record is honoured (24 hours, specification §5.3).
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Module that owns an audited entity.
 */
export type AuditModule = 'crm' | 'projects' | 'notes' | 'permissions';

/**
 * Safe audit metadata: scalar values only, never free text bodies or secrets.
 */
export type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

/**
 * One audit event to persist.
 */
export interface AuditEntry {
  /**
   * Event identifier.
   */
  readonly id: string;
  /**
   * Owning module.
   */
  readonly module: AuditModule;
  /**
   * Entity type, e.g. `contact`.
   */
  readonly entityType: string;
  /**
   * Entity identifier.
   */
  readonly entityId: string;
  /**
   * Action, e.g. `created`.
   */
  readonly action: string;
  /**
   * Acting user.
   */
  readonly actorId: string;
  /**
   * Request identifier.
   */
  readonly requestId: string;
  /**
   * Safe before/after metadata.
   */
  readonly metadata: AuditMetadata;
  /**
   * When it happened.
   */
  readonly occurredAt: string;
}

/**
 * One idempotency record to persist.
 */
export interface IdempotencyEntry {
  /**
   * Acting user.
   */
  readonly actorId: string;
  /**
   * Operation name, e.g. `crm.createContact`.
   */
  readonly operation: string;
  /**
   * Client-supplied key.
   */
  readonly key: string;
  /**
   * SHA-256 of the canonical request.
   */
  readonly requestHash: string;
  /**
   * JSON of the result returned to the caller.
   */
  readonly resultJson: string;
  /**
   * When it was stored.
   */
  readonly createdAt: string;
}

/**
 * The audit and idempotency rows committed with a mutation.
 */
export interface MutationEnvelope {
  /**
   * Audit events.
   */
  readonly audit: readonly AuditEntry[];
  /**
   * The idempotency record.
   */
  readonly idempotency: IdempotencyEntry;
  /**
   * Records older than this instant may be purged in the same write set.
   */
  readonly purgeBefore: string;
}

/**
 * A stored idempotency record.
 */
export interface StoredIdempotency {
  /**
   * SHA-256 of the canonical request.
   */
  readonly requestHash: string;
  /**
   * JSON of the stored result.
   */
  readonly resultJson: string;
}

/**
 * Port for reading idempotency records.
 */
export interface IdempotencyRepository {
  /**
   * Find an unexpired record.
   *
   * @param actorId Acting user.
   * @param operation Operation name.
   * @param key Client-supplied key.
   * @param notBefore Records created before this instant are treated as absent.
   * @returns The record, or `null`.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when storage fails.
   */
  findIdempotency(
    actorId: string,
    operation: string,
    key: string,
    notBefore: string
  ): Promise<StoredIdempotency | null>;
}

/**
 * Serialize a value with sorted object keys so equal inputs hash equally.
 *
 * @param value A JSON-compatible value.
 * @returns Canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Hash a canonical request.
 *
 * @param value The request (operation arguments).
 * @returns Lowercase hex SHA-256.
 */
export async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value))
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One in-flight idempotent mutation: check for a replay first, then build its envelope.
 */
export class IdempotentMutation {
  /**
   * @param operation Operation name.
   * @param actor The caller.
   * @param meta Idempotency metadata.
   * @param hash Hash of the canonical request.
   * @param runtime Clock and id source.
   */
  private constructor(
    readonly operation: string,
    private readonly actor: ActorContext,
    private readonly meta: MutationMeta,
    private readonly hash: string,
    private readonly runtime: Runtime
  ) {}

  /**
   * Begin a mutation.
   *
   * @param operation Operation name.
   * @param actor The caller.
   * @param meta Idempotency metadata.
   * @param request Every argument that defines the request, hashed for replay comparison.
   * @param runtime Clock and id source.
   * @returns The mutation.
   */
  static async begin(
    operation: string,
    actor: ActorContext,
    meta: MutationMeta,
    request: unknown,
    runtime: Runtime
  ): Promise<IdempotentMutation> {
    return new IdempotentMutation(operation, actor, meta, await requestHash(request), runtime);
  }

  /**
   * Look up an earlier result for the same key.
   *
   * This runs before version and existence checks, so a client that lost the response to a
   * successful update and retries it (now holding a stale version) receives the original result
   * instead of a spurious conflict.
   *
   * @param repository Idempotency storage.
   * @returns The earlier result, or `undefined` when this is a first attempt.
   * @throws {Error} An `IDEMPOTENCY_KEY_REUSED` service error when the key was used for a different
   *   request.
   */
  async replay<T>(repository: IdempotencyRepository): Promise<T | undefined> {
    const stored = await repository.findIdempotency(
      this.actor.userId,
      this.operation,
      this.meta.idempotencyKey,
      new Date(this.runtime.now().getTime() - IDEMPOTENCY_RETENTION_MS).toISOString()
    );
    if (stored === null) {
      return undefined;
    }
    if (stored.requestHash !== this.hash) {
      throw serviceError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
        { requestId: this.actor.requestId }
      );
    }
    return JSON.parse(stored.resultJson) as T;
  }

  /**
   * Build an audit entry for this mutation.
   *
   * @param module Owning module.
   * @param entityType Entity type.
   * @param entityId Entity identifier.
   * @param action Action name.
   * @param metadata Safe metadata.
   * @param occurredAt Instant of the change.
   * @returns The entry.
   */
  audit(
    module: AuditModule,
    entityType: string,
    entityId: string,
    action: string,
    metadata: AuditMetadata,
    occurredAt: string
  ): AuditEntry {
    return {
      id: this.runtime.newId(),
      module,
      entityType,
      entityId,
      action,
      actorId: this.actor.userId,
      requestId: this.actor.requestId,
      metadata,
      occurredAt
    };
  }

  /**
   * Build the envelope committed with the business change.
   *
   * @param result The value returned to the caller and stored for replay.
   * @param audit Audit entries for the change.
   * @param now Instant of the change.
   * @returns The envelope.
   */
  envelope(result: unknown, audit: readonly AuditEntry[], now: Date): MutationEnvelope {
    return {
      audit,
      idempotency: {
        actorId: this.actor.userId,
        operation: this.operation,
        key: this.meta.idempotencyKey,
        requestHash: this.hash,
        resultJson: JSON.stringify(result),
        createdAt: now.toISOString()
      },
      purgeBefore: new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS).toISOString()
    };
  }
}
