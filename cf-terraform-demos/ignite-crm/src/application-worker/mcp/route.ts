/**
 * MCP HTTP route composed into the authenticated Application Worker.
 */
import { Hono } from 'hono';
import { currentIdentityEmail } from '@demos/worker-common';
import type { ActorContext } from '../../shared/data-service/contract.ts';
import type { ApiEnv } from '../api/context.ts';
import { createCrmMcpHandler } from './server.ts';

/**
 * Builds the exact `/mcp` route. The SDK handler owns MCP protocol responses while Hono owns the
 * cross-cutting Access, request-id, and error middleware around it.
 *
 * @returns MCP router.
 */
export function mcpRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.on(['POST', 'GET'], '/', async (context) => {
    if (context.req.method === 'GET') {
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    }
    const resolved = await context
      .get('data')
      .resolveActor(currentIdentityEmail(context), context.get('requestId'));
    const actor: ActorContext = {
      email: resolved.email,
      userId: resolved.userId,
      requestId: context.get('requestId'),
      channel: 'mcp'
    };
    const session = await context.get('data').permissions.getSession(actor);
    const hostname = new URL(context.req.url).hostname;
    return createCrmMcpHandler(
      { data: context.get('data'), actor, permissions: session.permissions },
      hostname
    ).fetch(context.req.raw);
  });
  return router;
}
