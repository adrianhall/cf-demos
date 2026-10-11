/**
 * @file D1 adapter for the Permissions module.
 */

import { type Permission, PERMISSIONS, type Role, ROLES } from '../../../shared/permissions.ts';
import type {
  NewUser,
  PermissionsRepository,
  UserRecord
} from '../../application/permissions/permissions-service.ts';
import { type D1Port, sql } from '../d1/d1-port.ts';

/**
 * Row shape of the user lookup query.
 */
interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended';
  roles: string | null;
  permissions: string | null;
}

/**
 * Shared SELECT returning one user with comma-joined roles and permissions.
 */
const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.status,
         (SELECT group_concat(ur.role_id) FROM user_roles ur WHERE ur.user_id = u.id) AS roles,
         (SELECT group_concat(DISTINCT rp.permission)
            FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
           WHERE ur.user_id = u.id) AS permissions
    FROM users u`;

/**
 * Split a `group_concat` value, keeping only known vocabulary.
 *
 * @param joined Comma-joined values, or `null`.
 * @param allowed Recognised values.
 * @returns The recognised values, sorted.
 */
function splitKnown<T extends string>(joined: string | null, allowed: readonly T[]): T[] {
  if (joined === null) {
    return [];
  }
  return joined
    .split(',')
    .filter((value): value is T => (allowed as readonly string[]).includes(value))
    .sort();
}

/**
 * Map a user row.
 *
 * @param row The row.
 * @returns The record.
 */
function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    roles: splitKnown<Role>(row.roles, ROLES),
    permissions: splitKnown<Permission>(row.permissions, PERMISSIONS)
  };
}

/**
 * {@link PermissionsRepository} over D1.
 */
export class D1PermissionsRepository implements PermissionsRepository {
  /**
   * @param db The D1 port.
   */
  constructor(private readonly db: D1Port) {}

  /**
   * @inheritdoc
   */
  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db.readOne<UserRow>(sql(`${USER_SELECT} WHERE u.email = ?`, email));
    return row === null ? null : toUser(row);
  }

  /**
   * @inheritdoc
   */
  async findUserById(id: string): Promise<UserRecord | null> {
    const row = await this.db.readOne<UserRow>(sql(`${USER_SELECT} WHERE u.id = ?`, id));
    return row === null ? null : toUser(row);
  }

  /**
   * @inheritdoc
   */
  async provisionUser(user: NewUser): Promise<void> {
    await this.db.transaction(async (tx) => {
      // `OR IGNORE` on the unique e-mail makes concurrent first requests converge on one row; the
      // follow-up statements select by e-mail so they attach to whichever insert won.
      tx.write(
        sql(
          `INSERT OR IGNORE INTO users (id, email, display_name, status, version, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 1, ?, ?)`,
          user.id,
          user.email,
          user.displayName,
          user.createdAt,
          user.createdAt
        )
      );
      tx.write(
        sql(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at)
           SELECT id, ?, ? FROM users WHERE id = ?`,
          user.role,
          user.createdAt,
          user.id
        )
      );
      tx.write(
        sql(
          `INSERT INTO audit_events
             (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at)
           SELECT ?, 'permissions', 'user', id, 'provisioned', id, ?, json_object('role', ?), ?
             FROM users WHERE id = ?`,
          user.auditId,
          user.requestId,
          user.role,
          user.createdAt,
          user.id
        )
      );
      return Promise.resolve();
    });
  }
}
