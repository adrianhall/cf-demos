import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import { ShareService } from '../../src/worker/application/share-service.ts';
import type { AppBindings } from '../../src/worker/bindings.ts';
import { createDiagramsRouter } from '../../src/worker/routes/diagrams.ts';
import { createSharesRouter } from '../../src/worker/routes/shares.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeShareRepository } from './fake-share-repository.ts';

/**
 * @file Proves the share routes never write a raw token into an operational log. This has its own
 *   file because it is the one part of the token rule that storage assertions cannot reach. A log
 *   is not a store, so no amount of inspecting D1 or KV would catch a
 *   `LOGGER.info('diagram_shared', { token })`; and logs are precisely where a bearer credential
 *   does the most damage, because they are shipped to an observability backend, retained, and read
 *   by people who have no business holding a live share link. The routers are mounted over
 *   in-memory ports with a recording logger, which is the only level at which "what was logged" is
 *   observable at all — the Workers-runtime suite's logger writes to a capture transport the test
 *   cannot read back.
 */

const ALICE = 'alice@example.com';
const ORIGIN = 'https://diagrams.test';

/**
 * One recorded log call.
 */
interface LoggedEntry {
  /**
   * Event name the route logged.
   */
  event: string;
  /**
   * Structured context the route attached, if any.
   */
  context?: Record<string, unknown>;
}

/**
 * Builds an app mounting the share-bearing routers over in-memory ports and a recording logger.
 *
 * The Access middleware is replaced by a stub identity rather than exercised: this suite is about
 * what reaches the logger, and the Workers-runtime suite already proves that an unauthenticated
 * caller never reaches these handlers at all.
 *
 * @returns The app, the recorded log entries, and the diagram store the routes were given.
 */
function createApp(): {
  app: Hono<AppBindings>;
  entries: LoggedEntry[];
  diagrams: FakeDiagramRepository;
} {
  const diagrams = new FakeDiagramRepository();
  const shares = new FakeShareRepository();
  const diagramService = new DiagramService(diagrams, shares);
  const shareService = new ShareService(shares, diagramService);
  const entries: LoggedEntry[] = [];

  /**
   * Records one log call.
   *
   * @param event Event name.
   * @param context Structured context, if the caller supplied any.
   * @returns Nothing.
   */
  const record = (event: string, context?: Record<string, unknown>): void => {
    entries.push(context === undefined ? { event } : { context, event });
  };

  const app = new Hono<AppBindings>();
  app.use(async (context, next) => {
    context.set('Cloudflare_Access_Identity', {
      email: ALICE,
      source: 'header',
      sub: 'alice'
    } as never);
    context.set('DIAGRAM_SERVICE', diagramService);
    context.set('SHARE_SERVICE', shareService);
    context.set('LOGGER', {
      debug: record,
      error: record,
      fatal: record,
      info: record,
      trace: record,
      warn: record
    } as never);
    await next();
  });
  app.route('/api/diagrams', createDiagramsRouter());
  app.route('/api/shares', createSharesRouter());

  return { app, diagrams, entries };
}

/**
 * Builds an authenticated JSON request for the stubbed identity.
 *
 * @param path API path.
 * @param method HTTP method.
 * @returns The request.
 */
function jsonRequest(path: string, method: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    body: method === 'POST' ? '{}' : undefined,
    headers: { 'content-type': 'application/json' },
    method
  });
}

describe('share logging', () => {
  it('records the share event by diagram id, never by token', async () => {
    const { app, entries } = createApp();
    const created = await app.request(jsonRequest('/api/diagrams', 'POST'));
    const { diagram } = (await created.json()) as { diagram: { id: string } };
    entries.length = 0;

    const response = await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'POST'));
    const share = (await response.json()) as { token: string };

    expect(entries).toEqual([{ context: { diagramId: diagram.id }, event: 'diagram_shared' }]);
    expect(JSON.stringify(entries)).not.toContain(share.token);
  });

  it('records a revocation without a token', async () => {
    const { app, entries } = createApp();
    const created = await app.request(jsonRequest('/api/diagrams', 'POST'));
    const { diagram } = (await created.json()) as { diagram: { id: string } };
    const share = (await (
      await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'POST'))
    ).json()) as { token: string };
    entries.length = 0;

    await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'DELETE'));

    expect(entries).toEqual([
      { context: { diagramId: diagram.id }, event: 'diagram_share_revoked' }
    ]);
    expect(JSON.stringify(entries)).not.toContain(share.token);
  });

  // Reading the status is not an event worth a log line, and the only value that would
  // distinguish one from another is the thing that must never be written down.
  it('logs nothing at all when the status is read', async () => {
    const { app, entries } = createApp();
    const created = await app.request(jsonRequest('/api/diagrams', 'POST'));
    const { diagram } = (await created.json()) as { diagram: { id: string } };
    entries.length = 0;

    await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'GET'));

    expect(entries).toEqual([]);
  });

  // One entry per anonymous page view, whose only distinguishing value would be the token.
  it('logs nothing when an anonymous visitor resolves a link', async () => {
    const { app, entries } = createApp();
    const created = await app.request(jsonRequest('/api/diagrams', 'POST'));
    const { diagram } = (await created.json()) as { diagram: { id: string } };
    const share = (await (
      await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'POST'))
    ).json()) as { token: string };
    entries.length = 0;

    const response = await app.request(new Request(`${ORIGIN}/api/shares/${share.token}`));

    expect(response.status).toBe(200);
    expect(entries).toEqual([]);
  });

  // The belt-and-braces check: nothing the Worker hands to the global console carries a token
  // either, which would otherwise be a way around the structured logger entirely.
  it('writes no token to the console', async () => {
    const spies = (['debug', 'error', 'info', 'log', 'warn'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      const { app } = createApp();
      const created = await app.request(jsonRequest('/api/diagrams', 'POST'));
      const { diagram } = (await created.json()) as { diagram: { id: string } };
      const share = (await (
        await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'POST'))
      ).json()) as { token: string };

      await app.request(new Request(`${ORIGIN}/api/shares/${share.token}`));
      await app.request(jsonRequest(`/api/diagrams/${diagram.id}/share`, 'DELETE'));

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(share.token);
        }
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
