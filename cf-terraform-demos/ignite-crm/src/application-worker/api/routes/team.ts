/**
 * @file `/api/v1` team administration and audit routes: the team directory, the role catalogue,
 *   owner-only invite, role replacement, and status changes, and the owner/manager audit trail.
 *   Handlers stay thin: parse with the shared schema → resolve the actor → call the Data Worker →
 *   check the response against the shared schema. Every authorization decision — including "only
 *   owners manage the team" and "at least one active owner remains" — is the Data Worker's (see
 *   `src/data-worker/application/permissions/team-service.ts`); the SPA's capability hints only
 *   decide which controls to show.
 */

import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import { AuditListQuerySchema, AuditPageSchema } from '../../../shared/api/audit.ts';
import {
  InviteUserInputSchema,
  RoleCatalogueSchema,
  SetUserRolesInputSchema,
  SetUserStatusInputSchema,
  TeamListQuerySchema,
  TeamMemberSchema,
  TeamPageSchema
} from '../../../shared/api/team.ts';
import { DEFAULT_PAGE_SIZE } from '../../../shared/common/paging.ts';
import { actorOf, type ApiEnv } from '../context.ts';
import { expectedVersion, mutationMeta, pathId } from '../preconditions.ts';
import { checkResponse, parseRequest } from '../problems.ts';

/**
 * Build the team and audit router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function teamRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/roles', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(RoleCatalogueSchema, await context.get('data').permissions.listRoles(actor))
    );
  });

  router.get('/users', async (context) => {
    const query = parseRequest(
      TeamListQuerySchema,
      context.req.query(),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    const page = await context.get('data').permissions.listTeam(actor, {
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    return context.json(checkResponse(TeamPageSchema, page));
  });

  router.post('/users', jsonBodyLimit(), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      InviteUserInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const member = checkResponse(
      TeamMemberSchema,
      await context.get('data').permissions.inviteUser(actor, input, meta)
    );
    context.header('Location', `/api/v1/users/${member.id}`);
    context.header('ETag', `"${member.version}"`);
    return context.json(member, 201);
  });

  router.put('/users/:id/roles', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      SetUserRolesInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const member = checkResponse(
      TeamMemberSchema,
      await context.get('data').permissions.setUserRoles(actor, id, input, version, meta)
    );
    context.header('ETag', `"${member.version}"`);
    return context.json(member);
  });

  router.put('/users/:id/status', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      SetUserStatusInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const member = checkResponse(
      TeamMemberSchema,
      await context.get('data').permissions.setUserStatus(actor, id, input, version, meta)
    );
    context.header('ETag', `"${member.version}"`);
    return context.json(member);
  });

  router.get('/audit', async (context) => {
    const query = parseRequest(
      AuditListQuerySchema,
      context.req.query(),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    const { limit, ...filters } = query;
    const page = await context.get('data').permissions.listAudit(actor, {
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
      limit: limit ?? DEFAULT_PAGE_SIZE
    });
    return context.json(checkResponse(AuditPageSchema, page));
  });

  return router;
}
