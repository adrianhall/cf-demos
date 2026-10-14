/**
 * @file D1 adapter for team administration and the audit trail. All SQL is constant text with bound
 *   parameters; optional filters are bound as `NULL` and tested with `(? IS NULL OR column = ?)`,
 *   so statement text never depends on input. The role and status write set ends with the
 *   **final-owner guard**: a count of active owners evaluated inside the same `batch()`, after the
 *   change. If it is zero the batch rolls back. That is what makes "at least one active owner
 *   remains" safe against two owners demoting each other concurrently.
 */

import type { AuditEvent, AuditModuleName } from '../../../shared/api/audit.ts';
import type { RoleDefinition, TeamMember, UserStatus } from '../../../shared/api/team.ts';
import type { AuditListOptions } from '../../../shared/data-service/contract.ts';
import {
  type Permission,
  PERMISSIONS,
  type Role,
  ROLE_LABELS,
  ROLES
} from '../../../shared/permissions.ts';
import type {
  KeysetCriteria,
  StoredMember,
  TeamRepository
} from '../../application/permissions/team-service.ts';
import { sortRoles } from '../../application/permissions/team-service.ts';
import type { MutationEnvelope } from '../../application/shared/mutations.ts';
import { redactMetadata } from '../../domain/audit/audit.ts';
import { likeContains } from '../../domain/crm/contacts.ts';
import { type D1Port, sql, type SqlValue } from '../d1/d1-port.ts';
import { D1IdempotencyReader, writeEnvelope } from './envelope.ts';

/**
 * Row shape of a member projection.
 */
interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  status: UserStatus;
  roles: string | null;
  version: number;
  created_at: string;
}

/**
 * The member projection; callers append filters and ordering.
 */
const MEMBER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.status, u.version, u.created_at,
         (SELECT group_concat(ur.role_id) FROM user_roles ur WHERE ur.user_id = u.id) AS roles
    FROM users u`;

/**
 * Active users holding the owner role. Used both for the early check and the commit-time guard.
 */
const ACTIVE_OWNERS = `
  SELECT count(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id
   WHERE ur.role_id = 'owner' AND u.status = 'active'`;

/**
 * Map a member row.
 *
 * @param row The row.
 * @returns The member, with roles in catalogue order and unknown role ids dropped.
 */
function toMember(row: MemberRow): TeamMember {
  const roles = sortRoles(
    (row.roles ?? '')
      .split(',')
      .filter((role): role is Role => (ROLES as readonly string[]).includes(role))
  );
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    roles: roles.map((id) => ({ id, label: ROLE_LABELS[id] })),
    version: row.version,
    createdAt: row.created_at
  };
}

/**
 * Row shape of an audit projection.
 */
interface AuditRow {
  id: string;
  module: AuditModuleName;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  action: string;
  actor_id: string;
  actor_name: string;
  channel?: 'api' | 'chat' | 'mcp';
  request_id: string;
  metadata_json: string;
  occurred_at: string;
}

/**
 * {@link TeamRepository} over D1.
 */
export class D1TeamRepository extends D1IdempotencyReader implements TeamRepository {
  /**
   * @param port The D1 port.
   */
  constructor(private readonly port: D1Port) {
    super(port);
  }

  /**
   * @inheritdoc
   */
  async listRoles(): Promise<RoleDefinition[]> {
    const rows = await this.port.read<{ id: Role; label: string; permissions: string | null }>(
      sql(
        `SELECT r.id, r.label,
                (SELECT group_concat(rp.permission) FROM role_permissions rp WHERE rp.role_id = r.id)
                  AS permissions
           FROM roles r`
      )
    );
    return rows
      .filter((row) => (ROLES as readonly string[]).includes(row.id))
      .map((row) => ({
        id: row.id,
        label: row.label,
        permissions: (row.permissions ?? '')
          .split(',')
          .filter((permission): permission is Permission =>
            (PERMISSIONS as readonly string[]).includes(permission)
          )
          .sort((a, b) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(b))
      }));
  }

  /**
   * @inheritdoc
   */
  async listMembers(criteria: KeysetCriteria, q: string | null): Promise<StoredMember[]> {
    let text = `${MEMBER_SELECT} WHERE 1 = 1`;
    const params: SqlValue[] = [];
    if (q !== null) {
      text += " AND (lower(u.display_name) LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')";
      params.push(likeContains(q), likeContains(q));
    }
    if (criteria.after !== null) {
      text += ' AND (lower(u.display_name) > ? OR (lower(u.display_name) = ? AND u.id > ?))';
      params.push(criteria.after.key, criteria.after.key, criteria.after.id);
    }
    text += ' ORDER BY lower(u.display_name), u.id LIMIT ?';
    params.push(criteria.limit + 1);
    const rows = await this.port.read<MemberRow>(sql(text, ...params));
    return rows.map((row) => ({ ...toMember(row), sortKey: row.display_name.toLowerCase() }));
  }

  /**
   * @inheritdoc
   */
  async getMember(userId: string): Promise<TeamMember | null> {
    const row = await this.port.readOne<MemberRow>(sql(`${MEMBER_SELECT} WHERE u.id = ?`, userId));
    return row === null ? null : toMember(row);
  }

  /**
   * @inheritdoc
   */
  async findMemberByEmail(email: string): Promise<TeamMember | null> {
    const row = await this.port.readOne<MemberRow>(
      sql(`${MEMBER_SELECT} WHERE u.email = ?`, email)
    );
    return row === null ? null : toMember(row);
  }

  /**
   * @inheritdoc
   */
  async activeOwnerCount(): Promise<number> {
    const row = await this.port.readOne<{ n: number }>(sql(ACTIVE_OWNERS));
    return row?.n ?? 0;
  }

  /**
   * @inheritdoc
   */
  async insertMember(write: {
    id: string;
    email: string;
    displayName: string;
    roles: readonly Role[];
    grantedBy: string;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    await this.port.transaction((tx) => {
      // A plain INSERT: a concurrent invite or first sign-in for the same e-mail fails the unique
      // constraint and rolls the whole write set back as CONFLICT.
      tx.write(
        sql(
          `INSERT INTO users (id, email, display_name, status, version, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 1, ?, ?)`,
          write.id,
          write.email,
          write.displayName,
          write.at,
          write.at
        )
      );
      for (const role of write.roles) {
        tx.write(
          sql(
            'INSERT INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES (?, ?, ?, ?)',
            write.id,
            role,
            write.at,
            write.grantedBy
          )
        );
      }
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateMember(write: {
    userId: string;
    expectedVersion: number;
    roles: readonly Role[] | null;
    status: UserStatus | null;
    grantedBy: string;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    await this.port.transaction((tx) => {
      tx.write(
        sql(
          `UPDATE users SET status = coalesce(?, status), version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?`,
          write.status,
          write.at,
          write.userId,
          write.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      if (write.roles !== null) {
        // Keep the original grant (and its granter) for roles that stay; add only the new ones.
        tx.write(
          sql(
            `DELETE FROM user_roles
              WHERE user_id = ? AND role_id NOT IN (SELECT value FROM json_each(?))`,
            write.userId,
            JSON.stringify(write.roles)
          )
        );
        for (const role of write.roles) {
          tx.write(
            sql(
              `INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at, granted_by)
               VALUES (?, ?, ?, ?)`,
              write.userId,
              role,
              write.at,
              write.grantedBy
            )
          );
        }
      }
      // The final-owner invariant, evaluated after the change inside the same atomic batch.
      tx.requireRow(sql(ACTIVE_OWNERS), 'CONFLICT');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async listAudit(
    criteria: KeysetCriteria,
    filters: Omit<AuditListOptions, 'limit' | 'cursor'>
  ): Promise<AuditEvent[]> {
    const optional = (value: string | undefined): SqlValue => value ?? null;
    const params: SqlValue[] = [
      optional(filters.module),
      optional(filters.module),
      optional(filters.entityType),
      optional(filters.entityType),
      optional(filters.entityId),
      optional(filters.entityId),
      optional(filters.channel),
      optional(filters.channel),
      optional(filters.actorId),
      optional(filters.actorId)
    ];
    let text = `
      SELECT a.id, a.module, a.entity_type, a.entity_id, a.action, a.actor_id,
             u.display_name AS actor_name, a.channel, a.request_id, a.metadata_json, a.occurred_at,
             CASE a.entity_type
               WHEN 'contact' THEN (SELECT display_name FROM contacts WHERE id = a.entity_id)
               WHEN 'company' THEN (SELECT name FROM companies WHERE id = a.entity_id)
               WHEN 'deal' THEN (SELECT title FROM deals WHERE id = a.entity_id)
               WHEN 'activity' THEN (SELECT subject FROM activities WHERE id = a.entity_id)
               WHEN 'project' THEN (SELECT name FROM projects WHERE id = a.entity_id)
               WHEN 'task' THEN (SELECT title FROM tasks WHERE id = a.entity_id)
               WHEN 'note' THEN (SELECT title FROM notes WHERE id = a.entity_id)
               WHEN 'user' THEN (SELECT display_name FROM users WHERE id = a.entity_id)
             END AS entity_label
        FROM audit_events a JOIN users u ON u.id = a.actor_id
       WHERE (? IS NULL OR a.module = ?)
         AND (? IS NULL OR a.entity_type = ?)
         AND (? IS NULL OR a.entity_id = ?)
         AND (? IS NULL OR a.channel = ?)
         AND (? IS NULL OR a.actor_id = ?)`;
    if (criteria.after !== null) {
      text += ' AND (a.occurred_at < ? OR (a.occurred_at = ? AND a.id > ?))';
      params.push(criteria.after.key, criteria.after.key, criteria.after.id);
    }
    text += ' ORDER BY a.occurred_at DESC, a.id LIMIT ?';
    params.push(criteria.limit + 1);
    const rows = await this.port.read<AuditRow>(sql(text, ...params));
    return rows.map((row) => {
      const { metadata, redacted } = redactMetadata(row.metadata_json);
      return {
        id: row.id,
        module: row.module,
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityLabel: row.entity_label,
        action: row.action,
        actor: { id: row.actor_id, displayName: row.actor_name },
        channel: row.channel ?? 'api',
        requestId: row.request_id,
        metadata,
        redacted,
        occurredAt: row.occurred_at
      };
    });
  }
}
