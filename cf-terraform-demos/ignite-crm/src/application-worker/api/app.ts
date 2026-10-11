/**
 * @file The API module's Hono application factory. Middleware order matters and reads top to bottom
 *   as the request's path: logging → request id → Access verification (which also scrubs smuggled
 *   identity) → same-origin and content-type protections → data-service injection → routes. The
 *   data service is injected rather than constructed here, so tests run the same app against the
 *   fake Data Worker.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '@demos/worker-common';
import { configuration, toDisplayConfiguration } from '../../configuration.ts';
import { DisplayConfigurationSchema } from '../../shared/api/configuration.ts';
import { HealthSchema, SessionSchema } from '../../shared/api/session.ts';
import type { DataService } from '../../shared/data-service/contract.ts';
import { actorOf, type ApiEnv } from './context.ts';
import { jsonOnly, requestId, sameOrigin } from './middleware/protections.ts';
import { checkResponse, mapServiceError } from './problems.ts';
import { crmRoutes } from './routes/crm.ts';
import { notesRoutes } from './routes/notes.ts';
import { projectsRoutes } from './routes/projects.ts';
import { salesRoutes } from './routes/sales.ts';

/**
 * Inputs to {@link createApiApp}.
 */
export interface ApiAppOptions {
  /**
   * Cloudflare Access verification middleware.
   */
  readonly access: MiddlewareHandler<ApiEnv>;
  /**
   * Builds the data service for one request.
   */
  readonly dataService: (env: ApiEnv['Bindings']) => DataService;
  /**
   * Include stack traces on unexpected 500s; development only.
   */
  readonly includeStack: boolean;
}

/**
 * Build the API application.
 *
 * @param options Access middleware, data-service factory, and diagnostics switch.
 * @returns The Hono application.
 */
export function createApiApp(options: ApiAppOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.use(cloudflareLogger());
  app.use(requestId());
  app.use(options.access);
  app.use(sameOrigin());
  app.use(jsonOnly());
  app.use(async (context, next) => {
    context.set('data', options.dataService(context.env));
    await next();
  });

  app.route('/api/me', createMeRouter<ApiEnv>());

  app.get('/api/v1/health', async (context) =>
    context.json(
      checkResponse(HealthSchema, { status: 'ok', data: await context.get('data').health() })
    )
  );

  app.get('/api/v1/configuration', (context) =>
    context.json(checkResponse(DisplayConfigurationSchema, toDisplayConfiguration(configuration)))
  );

  app.get('/api/v1/session', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(SessionSchema, await context.get('data').permissions.getSession(actor))
    );
  });

  app.route('/api/v1', crmRoutes());
  app.route('/api/v1', salesRoutes());
  app.route('/api/v1', projectsRoutes());
  app.route('/api/v1', notesRoutes());

  app.onError(
    problemDetailsErrorHandler({ includeStack: options.includeStack, mapError: mapServiceError })
  );
  app.notFound(notFoundHandler());

  return app;
}
