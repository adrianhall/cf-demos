import { Hono } from 'hono';

/**
 * Worker entry point, routed by Hono.
 *
 * Every binding you drew on the canvas is declared in `cloudflare.config.ts` and reaches a handler
 * through `c.env`. Run `cf workers types` to generate the matching `Env` type, then declare it as
 * `new Hono<{ Bindings: Env }>()` to have those bindings typed.
 */
const app = new Hono();

app.get('/', (c) => c.text('Hello from Hono on Cloudflare Workers!'));

app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
