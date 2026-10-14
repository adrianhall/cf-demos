/**
 * @file Application Worker entrypoint (`ignite-crm-application`): the public edge. Composes the API
 *   module with the real Access middleware and the `DATA_SERVICE` RPC binding. Static SPA assets
 *   are served by the platform before this code runs (`runWorkerFirst` covers only `/api/*`). Chat
 *   sessions are routed to the SQLite-backed `CrmChatAgent` Durable Object.
 */

import { createLogger, resolveLoggerConfig } from '@adrianhall/cloudflare-toolkit/logging';
import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from './api/access-policies.ts';
import { createApiApp } from './api/app.ts';
import type { ApiEnv } from './api/context.ts';
import { createDataClient } from './data-client.ts';

/**
 * Bindings of the deployed Application Worker.
 */
type WorkerBindings = ApiEnv['Bindings'] & { readonly DATA_SERVICE: Env['DATA_SERVICE'] };

/**
 * The Application Worker's Hono app.
 */
const app = createApiApp({
  // `import.meta.env.DEV` is statically `false` in a production build, so development tokens can
  // never be accepted by a deployed Worker.
  access: createAccessMiddleware<ApiEnv>({
    buildPolicies: buildAccessPolicies,
    enableDevTokens: import.meta.env.DEV
  }),
  dataService: (env) =>
    createDataClient((env as WorkerBindings).DATA_SERVICE, {
      onTransportError: (error) =>
        createLogger({
          ...resolveLoggerConfig(env.ENVIRONMENT, 'worker'),
          bindings: { service: 'ignite-crm-application' }
        }).error('data service transport failure', {
          dependency: 'DATA_SERVICE',
          error: error instanceof Error ? error.message : String(error)
        })
    }),
  includeStack: import.meta.env.DEV
});

export default app;
