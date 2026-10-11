/**
 * @file Session wire schemas: `GET /api/me` and `GET /api/v1/session`. `/api/me` is the shared
 *   router's primitive identity (just the verified e-mail). The session adds the installation-local
 *   user, role summaries, and capability hints. Hints let the SPA hide controls a user cannot use;
 *   they never grant anything, because the Data Worker re-authorizes every operation.
 */

import * as v from 'valibot';
import { IdSchema } from '../common/ids.ts';
import { PermissionSchema, RoleSchema } from '../permissions.ts';

/**
 * `GET /api/me` response.
 */
export const MeSchema = v.strictObject({
  /**
   * Verified Access e-mail.
   */
  email: v.string()
});

/**
 * `/api/me` response body.
 */
export type Me = v.InferOutput<typeof MeSchema>;

/**
 * A role summary.
 */
export const RoleSummarySchema = v.strictObject({
  /**
   * Role identifier.
   */
  id: RoleSchema,
  /**
   * Display name.
   */
  label: v.string()
});

/**
 * A role summary.
 */
export type RoleSummary = v.InferOutput<typeof RoleSummarySchema>;

/**
 * `GET /api/v1/session` response.
 */
export const SessionSchema = v.strictObject({
  /**
   * The signed-in installation user.
   */
  user: v.strictObject({
    /**
     * User identifier.
     */
    id: IdSchema,
    /**
     * Verified e-mail.
     */
    email: v.string(),
    /**
     * Display name.
     */
    displayName: v.string()
  }),
  /**
   * Roles held by the user.
   */
  roles: v.array(RoleSummarySchema),
  /**
   * Capability hints: the union of the user's role permissions.
   */
  permissions: v.array(PermissionSchema)
});

/**
 * A session.
 */
export type Session = v.InferOutput<typeof SessionSchema>;

/**
 * `GET /api/v1/health` response.
 */
export const HealthSchema = v.strictObject({
  /**
   * Overall status.
   */
  status: v.literal('ok'),
  /**
   * Data Worker status, including the latest applied migration.
   */
  data: v.strictObject({
    /**
     * Data Worker status.
     */
    status: v.literal('ok'),
    /**
     * Name of the most recent applied migration.
     */
    migration: v.string()
  })
});

/**
 * A health report.
 */
export type Health = v.InferOutput<typeof HealthSchema>;
