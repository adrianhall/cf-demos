import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { TASK_DESCRIPTORS } from '../../../src/shared/tasks';
import { catalogueRouter } from '../../../src/worker/routes/catalogue';

/**
 * Mounts the catalogue router on its own Hono app, without the Access middleware.
 *
 * Authentication is covered by the Workers-runtime suite against the real Worker. Here the router
 * is exercised in isolation so a failure points at the route's own behaviour rather than at the
 * middleware stack.
 *
 * @returns An app serving the catalogue at `/api/catalogue`.
 */
function mountCatalogue(): Hono {
  const app = new Hono();
  app.route('/api/catalogue', catalogueRouter);
  return app;
}

/**
 * Requests the catalogue and parses the response body.
 *
 * @returns The response and its decoded body.
 */
async function fetchCatalogue() {
  const response = await mountCatalogue().request('/api/catalogue');
  const body = (await response.json()) as {
    tasks: { id: string; gateway: string }[];
    models: unknown[];
    gatewayExceptions: unknown[];
  };
  return { response, body };
}

describe('GET /api/catalogue', () => {
  it('returns every panel', async () => {
    const { response, body } = await fetchCatalogue();
    expect(response.status).toBe(200);
    expect(body.tasks.map((task) => task.id)).toEqual(TASK_DESCRIPTORS.map((task) => task.id));
  });

  it('returns the reviewed model list and the exception register', async () => {
    const { body } = await fetchCatalogue();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.gatewayExceptions).toEqual([
      expect.objectContaining({ id: 'flux-2-workers-ai-multipart-stream', panel: 'Remix Image' })
    ]);
  });

  // The endpoint sits behind Access, but it is also the response most likely to be copied into a
  // bug report or a screenshot. Serialising a credential here would be a quiet, durable leak, so
  // the absence is asserted rather than assumed from the fact that none is currently referenced.
  it('discloses no credential, account identifier, or gateway token', async () => {
    // A fresh request rather than the shared helper's: a response body can only be read once, and
    // this assertion needs the raw text the helper already consumed as JSON.
    const text = await (await mountCatalogue().request('/api/catalogue')).text();
    for (const forbidden of [
      'CLOUDFLARE_API_TOKEN',
      'ACCESS_AUD',
      'AI_GATEWAY_ID',
      'CLOUDFLARE_ACCOUNT_ID',
      'apiToken',
      'secret'
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  // The UI reads `gateway` from this payload to decide which badge a panel shows. If the server
  // ever stopped sending it, every panel would silently render as if it were local-only.
  it('states the gateway requirement of every panel', async () => {
    const { body } = await fetchCatalogue();
    for (const task of body.tasks) {
      expect(['required', 'none']).toContain(task.gateway);
    }
  });
});
