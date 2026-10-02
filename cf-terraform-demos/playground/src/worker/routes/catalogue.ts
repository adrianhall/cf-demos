import { Hono } from 'hono';
import { TASK_DESCRIPTORS } from '../../shared/tasks';
import type { AppBindings } from '../bindings';
import { GATEWAY_EXCEPTIONS } from '../domain/gateway-exceptions';
import { MODEL_DESCRIPTORS } from '../domain/models';

/**
 * Public catalogue of panels, reviewed models, and the gateway exception register, mounted at
 * `/api/catalogue`.
 *
 * The browser could import the panel list directly — it is a shared module — but it cannot import
 * model descriptors or the exception register, which live in the Worker's domain tier. Serving all
 * three from one endpoint gives the UI a single consistent view of what the server will actually
 * accept, rather than a client-side guess that can drift from it.
 *
 * Everything returned here is already public by construction: panel names, reviewed model
 * identifiers that appear in Cloudflare's own catalog, and documented exceptions. No credential,
 * provider key, account identifier, or gateway token is included. The endpoint is nonetheless
 * behind Access like every other route, because the application has no anonymous surface at all.
 */
export const catalogueRouter = new Hono<AppBindings>();

/**
 * Returns the panel catalogue, the reviewed model list, and the AI Gateway exception register.
 *
 * @param context Hono request context.
 * @returns A JSON `200` response with `tasks`, `models`, and `gatewayExceptions`. The exception
 *   list is normally empty, and the UI renders that emptiness as a positive statement — every
 *   inference path is gateway-routed — rather than omitting the section.
 */
catalogueRouter.get('/', (context) =>
  context.json({
    tasks: TASK_DESCRIPTORS,
    models: MODEL_DESCRIPTORS,
    gatewayExceptions: GATEWAY_EXCEPTIONS
  })
);
