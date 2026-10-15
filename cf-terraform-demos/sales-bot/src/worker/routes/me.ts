import { Hono } from 'hono';
import { currentIdentityEmail } from '@demos/worker-common';
import type { AppBindings } from '../bindings';

/**
 * Routes that expose the verified identity to the application shell.
 */
export const meRouter = new Hono<AppBindings>();

meRouter.get('/', async (context) => {
  const identity = await context.get('IDENTITY_SERVICE').getMe(currentIdentityEmail(context));
  return context.json(identity);
});
