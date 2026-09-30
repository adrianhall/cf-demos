import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  createChannel,
  listChannelNames,
  requestAs,
  send,
  testEnv,
  uniqueChannelName
} from './fixtures';

/**
 * A syntactically valid channel name that is never created, for "no such channel" paths.
 */
const MISSING = 'never-created';

describe('Chat Worker API', () => {
  beforeAll(async () => {
    // Builds the schema from the real migration SQL, so a broken migration fails these tests
    // rather than only failing a deploy.
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM channels').run();
  });

  describe('authentication', () => {
    it.each([
      ['GET', '/api/me'],
      ['GET', '/api/channels'],
      ['POST', '/api/channels'],
      ['DELETE', '/api/channels/general'],
      ['GET', '/api/channels/general/socket']
    ])('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const response = await send(new Request(`https://chat.example${path}`, { method }));

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The WebSocket upgrade is authenticated by the same middleware as every other route: it is
    // a same-origin request carrying the same credential, so there is no separate socket
    // authentication path that could be weaker.
    it('rejects an unauthenticated WebSocket upgrade', async () => {
      const response = await send(
        new Request('https://chat.example/api/channels/general/socket', {
          headers: { Upgrade: 'websocket' }
        })
      );

      expect(response.status).toBe(401);
    });

    // Every Access application in a team shares one JWKS, so a correctly signed token minted
    // for a different application would pass signature validation. The audience check stops it.
    it('rejects a valid token minted for a different Access application', async () => {
      const response = await send(await requestAs('/api/channels', {}, ALICE, 'b'.repeat(64)));

      expect(response.status).toBe(401);
    });

    it('accepts a token for the configured audience', async () => {
      const response = await send(await requestAs('/api/me'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: ALICE });
    });

    // There is no anonymous surface: unlike the sibling `link` demo, no path bypasses Access.
    it('has no public route', async () => {
      const response = await send(new Request('https://chat.example/api/channels'));
      expect(response.status).toBe(401);
    });
  });

  describe('channel directory', () => {
    it('creates a channel attributed to the verified identity', async () => {
      const response = await send(
        await requestAs('/api/channels', {
          body: JSON.stringify({ name: 'deploys' }),
          method: 'POST'
        })
      );

      expect(response.status).toBe(201);
      expect((await response.json()) as unknown).toMatchObject({
        channel: { name: 'deploys', createdBy: ALICE }
      });
    });

    it('normalizes the stored name', async () => {
      await createChannel('  Deploys  ');
      expect(await listChannelNames()).toEqual(['deploys']);
    });

    it('lists channels in name order', async () => {
      await createChannel('zulu');
      await createChannel('alpha');
      await createChannel('mike');

      expect(await listChannelNames()).toEqual(['alpha', 'mike', 'zulu']);
    });

    // The database's primary key is the arbiter, so a duplicate cannot overwrite the original's
    // provenance.
    it('refuses a duplicate name with 409 and keeps the original creator', async () => {
      await createChannel('deploys', ALICE);

      const response = await send(
        await requestAs(
          '/api/channels',
          { body: JSON.stringify({ name: 'deploys' }), method: 'POST' },
          BOB
        )
      );
      expect(response.status).toBe(409);

      const row = await testEnv.DB.prepare('SELECT created_by FROM channels WHERE name = ?')
        .bind('deploys')
        .first<{ created_by: string }>();
      expect(row?.created_by).toBe(ALICE);
    });

    it('treats a differently-cased duplicate as the same channel', async () => {
      await createChannel('deploys');

      const response = await send(
        await requestAs('/api/channels', {
          body: JSON.stringify({ name: 'DEPLOYS' }),
          method: 'POST'
        })
      );

      expect(response.status).toBe(409);
    });

    it('removes a channel', async () => {
      await createChannel('deploys');

      const response = await send(await requestAs('/api/channels/deploys', { method: 'DELETE' }));

      expect(response.status).toBe(204);
      expect(await listChannelNames()).toEqual([]);
    });

    it('answers removal of an unknown channel with 404', async () => {
      const response = await send(
        await requestAs(`/api/channels/${MISSING}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(404);
    });
  });

  // The workspace is shared, which is the opposite of the sibling `todo` demo's per-user
  // isolation. These tests state that explicitly so the difference is deliberate rather than
  // incidental.
  describe('shared workspace', () => {
    it('shows one participant the channels another created', async () => {
      await createChannel('alices-channel', ALICE);

      expect(await listChannelNames(BOB)).toEqual(['alices-channel']);
    });

    it('lets any participant remove any channel', async () => {
      await createChannel('alices-channel', ALICE);

      const response = await send(
        await requestAs('/api/channels/alices-channel', { method: 'DELETE' }, BOB)
      );

      expect(response.status).toBe(204);
      expect(await listChannelNames(ALICE)).toEqual([]);
    });
  });

  describe('validation', () => {
    it.each([
      ['a missing name', {}],
      ['a non-string name', { name: 42 }],
      ['an empty name', { name: '' }],
      ['a leading digit', { name: '1team' }],
      ['spaces inside', { name: 'my team' }],
      ['an over-long name', { name: 'a'.repeat(33) }],
      ['a reserved name', { name: 'api' }],
      ['an attempt to choose the creator', { name: 'ok', createdBy: 'mallory@example.com' }]
    ])('rejects %s with 422', async (_label, body) => {
      const response = await send(
        await requestAs('/api/channels', { body: JSON.stringify(body), method: 'POST' })
      );

      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('rejects malformed JSON with 400', async () => {
      const response = await send(
        await requestAs('/api/channels', { body: '{"name":', method: 'POST' })
      );

      expect(response.status).toBe(400);
    });

    it('rejects an oversized body with 400', async () => {
      const response = await send(
        await requestAs('/api/channels', {
          body: JSON.stringify({ name: 'a'.repeat(9_000) }),
          method: 'POST'
        })
      );

      expect(response.status).toBe(400);
    });

    // 404 rather than 422, so a caller cannot tell an invalid name from one that was never
    // created.
    it.each(['not valid', 'UPPER CASE', '1bad'])(
      'answers removal of the malformed name %s with 404',
      async (name) => {
        const response = await send(
          await requestAs(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' })
        );

        expect(response.status).toBe(404);
      }
    );
  });

  describe('the socket route', () => {
    // 426 rather than 400: the request is well-formed and the resource exists, but it can only
    // be used over a different protocol.
    it('answers a plain GET with 426 Upgrade Required', async () => {
      await createChannel('deploys');

      const response = await send(await requestAs('/api/channels/deploys/socket'));

      expect(response.status).toBe(426);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // Durable Objects are addressed purely by name, so without the directory check any string
    // would be a valid — and permanently invisible — channel.
    it('refuses to open a room for a channel nobody created', async () => {
      const response = await send(
        await requestAs(`/api/channels/${uniqueChannelName()}/socket`, {
          headers: { Upgrade: 'websocket' }
        })
      );

      expect(response.status).toBe(404);
    });

    it('answers a malformed channel name with 404', async () => {
      const response = await send(
        await requestAs('/api/channels/not%20valid/socket', {
          headers: { Upgrade: 'websocket' }
        })
      );

      expect(response.status).toBe(404);
    });
  });

  describe('error shape', () => {
    it('returns RFC 9457 problem details without a stack trace', async () => {
      const response = await send(
        await requestAs('/api/channels', { body: JSON.stringify({ name: '' }), method: 'POST' })
      );

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 422 });
      expect(body).not.toHaveProperty('stack');
    });

    it('answers an unknown API route with a 404 problem document', async () => {
      const response = await send(await requestAs('/api/nope'));

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });
  });
});
