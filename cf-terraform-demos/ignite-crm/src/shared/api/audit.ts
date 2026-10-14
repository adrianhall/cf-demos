/**
 * @file Audit trail wire schemas: one shared, newest-first, cursor-paged list over the single
 *   `audit_events` table (specification §7.3). Every module writes to the same table inside its own
 *   write set, so the trail cannot disagree with the data it describes. Audit rows carry **safe
 *   metadata only**: identifiers, field names, statuses, counts, and a SHA-256 digest where content
 *   changed. Note bodies, free-text status lines, and tokens are never stored; the projection
 *   additionally passes metadata through an allowlist (`src/data-worker/domain/audit/audit.ts`) so
 *   a future writer that slips in an unexpected key cannot leak it through this route.
 */

import * as v from 'valibot';
import { TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import { UserRefSchema } from './crm.ts';

/**
 * Modules that write audit events.
 */
export const AUDIT_MODULES = ['crm', 'projects', 'notes', 'permissions'] as const;

/**
 * Composition surfaces that can create an audit event.
 */
export const AUDIT_CHANNELS = ['api', 'chat', 'mcp'] as const;

/**
 * Schema for an audit channel.
 */
export const AuditChannelSchema = v.picklist(AUDIT_CHANNELS);

/**
 * Schema for an audit module.
 */
export const AuditModuleSchema = v.picklist(
  AUDIT_MODULES,
  'Module must be crm, projects, notes, or permissions.'
);

/**
 * An audit module.
 */
export type AuditModuleName = v.InferOutput<typeof AuditModuleSchema>;

/**
 * Entity types that appear in the trail, in filter display order.
 */
export const AUDIT_ENTITY_TYPES = [
  'contact',
  'company',
  'deal',
  'activity',
  'project',
  'task',
  'note',
  'user'
] as const;

/**
 * Schema for an audited entity type.
 */
export const AuditEntityTypeSchema = v.picklist(AUDIT_ENTITY_TYPES, 'Unknown entity type.');

/**
 * An audited entity type.
 */
export type AuditEntityType = v.InferOutput<typeof AuditEntityTypeSchema>;

/**
 * One safe metadata value.
 */
export const AuditValueSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/**
 * One audit event as shown to an owner or manager.
 */
export const AuditEventSchema = v.strictObject({
  /**
   * Event identifier.
   */
  id: IdSchema,
  /**
   * Module that wrote it.
   */
  module: AuditModuleSchema,
  /**
   * Entity type.
   */
  entityType: v.string(),
  /**
   * Entity identifier.
   */
  entityId: v.string(),
  /**
   * The entity's current name or title, or `null` when it no longer resolves. Never body text.
   */
  entityLabel: v.nullable(v.string()),
  /**
   * What happened, for example `created` or `roles-changed`.
   */
  action: v.string(),
  /**
   * Composition surface that initiated the change.
   */
  channel: v.optional(AuditChannelSchema, 'api'),
  /**
   * Who did it.
   */
  actor: UserRefSchema,
  /**
   * Request identifier, for correlating with logs.
   */
  requestId: v.string(),
  /**
   * Allowlisted metadata: ids, field names, statuses, counts, and content digests.
   */
  metadata: v.record(v.string(), AuditValueSchema),
  /**
   * Whether the projection removed metadata keys that are not on the allowlist.
   */
  redacted: v.boolean(),
  /**
   * When it happened.
   */
  occurredAt: TimestampSchema
});

/**
 * One audit event.
 */
export type AuditEvent = v.InferOutput<typeof AuditEventSchema>;

/**
 * One page of audit events, newest first.
 */
export const AuditPageSchema = pageSchema(AuditEventSchema);

/**
 * Query string for the audit trail. Every filter is optional and they combine with AND.
 */
export const AuditListQuerySchema = v.strictObject({
  /**
   * Only events from this module.
   */
  module: v.optional(AuditModuleSchema),
  /**
   * Only events about this entity type.
   */
  entityType: v.optional(AuditEntityTypeSchema),
  /**
   * Only events about this entity (usually with `entityType`).
   */
  entityId: v.optional(IdSchema),
  /**
   * Only events from this composition surface.
   */
  channel: v.optional(AuditChannelSchema),
  /**
   * Only events by this user.
   */
  actorId: v.optional(IdSchema),
  /**
   * Page size, 1–100.
   */
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,3}$/u, 'limit must be a whole number.'),
      v.transform(Number),
      v.minValue(1, 'limit must be at least 1.'),
      v.maxValue(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}.`)
    )
  ),
  /**
   * Cursor from the previous page.
   */
  cursor: v.optional(CursorSchema)
});

/**
 * A validated audit query.
 */
export type AuditListQuery = v.InferOutput<typeof AuditListQuerySchema>;
