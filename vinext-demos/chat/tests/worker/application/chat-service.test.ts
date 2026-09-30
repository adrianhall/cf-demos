import { describe, expect, it } from 'vitest';
import { ChatService } from '../../../src/worker/application/chat-service';
import { channelNamed, createFakePorts } from '../support/fake-ports';
import { problemWithStatus } from '../support/problem-details';

const ALICE = 'alice@example.com';

/**
 * Build a service over in-memory ports.
 *
 * @param seededNames Channels the directory starts with.
 * @returns The service and the shared operation log both ports write to.
 */
function serviceWith(seededNames: string[] = []) {
  const ports = createFakePorts(seededNames.map(channelNamed));
  return { service: new ChatService(ports.channels, ports.rooms), ports };
}

/**
 * Build an upgrade request to pass through the service.
 *
 * The service never inspects it — the transport tier checks the `Upgrade` header and the adapter
 * rewrites the identity one — so this only has to be a `Request`.
 *
 * @returns A WebSocket upgrade request.
 */
function upgradeRequest(): Request {
  return new Request('https://chat.example/api/channels/general/socket', {
    headers: { Upgrade: 'websocket' }
  });
}

describe('ChatService', () => {
  describe('listChannels', () => {
    it('returns every channel', async () => {
      const { service } = serviceWith(['general', 'deploys']);

      expect((await service.listChannels()).map((channel) => channel.name)).toEqual([
        'deploys',
        'general'
      ]);
    });

    // Unlike the sibling `todo` demo there is no identity filter: this is a shared workspace, so
    // listing takes no participant at all. That the method has no such parameter is the
    // guarantee; this test records it as intentional.
    it('needs no participant identity to list', async () => {
      const { service } = serviceWith(['general']);
      expect(await service.listChannels()).toHaveLength(1);
    });
  });

  describe('createChannel', () => {
    it('stores a normalized name attributed to the verified identity', async () => {
      const { service } = serviceWith();

      expect(await service.createChannel({ name: '  Deploys ' }, ALICE)).toMatchObject({
        name: 'deploys',
        createdBy: ALICE
      });
    });

    it('rejects an invalid payload before touching storage', async () => {
      const { service, ports } = serviceWith();

      await expect(service.createChannel({ name: '' }, ALICE)).rejects.toMatchObject(
        problemWithStatus(422)
      );
      expect(ports.operations).toEqual([]);
    });

    // A room is never pre-created. A channel is its name; the room comes into being when
    // somebody first joins. Creating one here would introduce a half-state to reconcile.
    it('creates no room', async () => {
      const { service, ports } = serviceWith();
      await service.createChannel({ name: 'deploys' }, ALICE);

      expect(ports.operations.filter((entry) => entry.port === 'rooms')).toEqual([]);
    });
  });

  describe('joinChannel', () => {
    // Returned by reference, not rebuilt: a real upgrade response carries the client end of the
    // socket in a `webSocket` property, which reconstructing the response would silently drop.
    it('returns the room’s upgrade response unchanged', async () => {
      const { service, ports } = serviceWith(['general']);

      expect(await service.joinChannel('general', upgradeRequest(), ALICE)).toBe(
        ports.upgradeResponse
      );
    });

    it('normalizes the requested name before addressing the room', async () => {
      const { service, ports } = serviceWith(['general']);
      await service.joinChannel('  General  ', upgradeRequest(), ALICE);

      expect(ports.operations).toContainEqual({
        port: 'rooms',
        operation: 'join',
        channel: 'general',
        participant: ALICE
      });
    });

    // The identity reaches the room as an argument rather than being derived there. This is the
    // application-layer half of the authorship guarantee.
    it('passes the verified identity through to the room unchanged', async () => {
      const { service, ports } = serviceWith(['general']);
      await service.joinChannel('general', upgradeRequest(), 'bob@example.com');

      expect(ports.operations).toContainEqual({
        port: 'rooms',
        operation: 'join',
        channel: 'general',
        participant: 'bob@example.com'
      });
    });

    // Durable Objects are addressed purely by name, so without the directory check any string
    // would silently be a valid channel — permanently invisible to everybody else.
    it('refuses to join a channel nobody created', async () => {
      const { service, ports } = serviceWith(['general']);

      await expect(
        service.joinChannel('never-made', upgradeRequest(), ALICE)
      ).rejects.toMatchObject(problemWithStatus(404));
      expect(ports.operations.filter((entry) => entry.port === 'rooms')).toEqual([]);
    });

    it('answers a malformed name with 404 rather than a validation error', async () => {
      const { service } = serviceWith(['general']);

      await expect(service.joinChannel('not valid', upgradeRequest(), ALICE)).rejects.toMatchObject(
        problemWithStatus(404)
      );
    });
  });

  describe('removeChannel', () => {
    // The rule this demo exists to show on the teardown path. Delisting first would leave
    // connected participants talking in a channel nobody can find or join; destroying first
    // fails safe, because a channel that is still listed but empty can simply be removed again.
    it('destroys the room before delisting the channel', async () => {
      const { service, ports } = serviceWith(['general']);
      await service.removeChannel('general');

      const mutations = ports.operations.filter(
        (entry) => entry.operation === 'destroy' || entry.operation === 'remove'
      );
      expect(mutations).toEqual([
        { port: 'rooms', operation: 'destroy', channel: 'general' },
        { port: 'channels', operation: 'remove', name: 'general' }
      ]);
    });

    it('removes the channel from the directory', async () => {
      const { service } = serviceWith(['general', 'deploys']);
      await service.removeChannel('general');

      expect((await service.listChannels()).map((channel) => channel.name)).toEqual(['deploys']);
    });

    it('answers an unknown channel with 404 and touches neither store', async () => {
      const { service, ports } = serviceWith(['general']);

      await expect(service.removeChannel('never-made')).rejects.toMatchObject(
        problemWithStatus(404)
      );
      expect(
        ports.operations.filter(
          (entry) => entry.operation === 'destroy' || entry.operation === 'remove'
        )
      ).toEqual([]);
    });

    it('answers a malformed name with 404', async () => {
      const { service } = serviceWith(['general']);

      await expect(service.removeChannel('../escape')).rejects.toMatchObject(
        problemWithStatus(404)
      );
    });

    it('normalizes the name before removing', async () => {
      const { service, ports } = serviceWith(['general']);
      await service.removeChannel('GENERAL');

      expect(ports.operations).toContainEqual({
        port: 'channels',
        operation: 'remove',
        name: 'general'
      });
    });
  });
});
