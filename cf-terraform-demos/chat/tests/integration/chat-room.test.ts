import { applyD1Migrations, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_REMOVED_CLOSE_CODE } from '../../src/chat-protocol';
import {
  ALICE,
  BOB,
  createChannel,
  expectNoFrameOfType,
  nextClose,
  nextFrameOfType,
  nextPresenceOf,
  openSocket,
  requestAs,
  send,
  testEnv,
  uniqueChannelName
} from './fixtures';

/**
 * Exercises the `ChatRoom` Durable Object through the real, fully-authenticated route rather than
 * by calling the stub directly, so the Worker's identity handling is actually under test instead of
 * assumed.
 *
 * Three rules keep this suite deterministic rather than flaky, and each was chosen for a specific
 * reason:
 *
 * - **Every test uses a fresh, randomly named channel.** Durable Object storage survives eviction —
 *   only `destroy()` erases it — so reusing a name would leak one test's messages and participant
 *   counts into another's.
 * - **Every socket is tracked and `afterEach` evicts with `{ webSockets: 'close' }`.** Awaiting an
 *   outbound close handshake is unreliable in this pool even when the server side has already
 *   closed, so cleanup does not depend on it. Eviction is the documented, unconditional way to
 *   force every hibernatable socket closed, so a failed assertion can never leave a socket open and
 *   block the shared runtime from tearing down.
 * - **Assertions that must prove something did _not_ happen read storage directly** with
 *   `runInDurableObject`, rather than racing a message against a timer — the pattern that produces
 *   intermittent hangs.
 */
describe('ChatRoom coordination', () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM channels').run();
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: 'close' });
  });

  /**
   * Create a fresh channel and join it, returning the socket and its replayed history.
   *
   * @param email Identity to connect as.
   * @param channel Channel to join; a fresh one is created when omitted.
   * @returns The channel name, the connected socket, and its history frame.
   */
  async function joinFreshChannel(email: string = ALICE, channel?: string) {
    const name = channel ?? (await createChannel(uniqueChannelName(), email));
    const socket = await openSocket(name, email);
    openSockets.add(socket);
    const history = await nextFrameOfType(socket, 'history');
    return { name, socket, history };
  }

  /**
   * Join an already-created channel.
   *
   * @param channel Channel to join.
   * @param email Identity to connect as.
   * @returns The connected socket, after its history frame has arrived.
   */
  async function join(channel: string, email: string): Promise<WebSocket> {
    const socket = await openSocket(channel, email);
    openSockets.add(socket);
    await nextFrameOfType(socket, 'history');
    return socket;
  }

  /**
   * Read a channel's stored messages straight from its Durable Object storage.
   *
   * Reading storage rather than watching the socket is how a test proves a message was _not_
   * accepted, without racing a broadcast against a timeout.
   *
   * @param channel Channel whose room is inspected.
   * @returns Every stored message, oldest first.
   */
  async function storedMessages(channel: string): Promise<{ author: string; body: string }[]> {
    const stub = testEnv.CHAT_ROOM.getByName(channel);
    return runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ author: string; body: string }>('SELECT author, body FROM messages ORDER BY id')
        .toArray()
        .map((row) => ({ author: row.author, body: row.body }))
    );
  }

  describe('joining', () => {
    it('accepts an authenticated upgrade and replays an empty history', async () => {
      const { history } = await joinFreshChannel();

      expect(history).toEqual({ type: 'history', messages: [] });
    });

    it('reports the participant count as people join', async () => {
      const { name, socket } = await joinFreshChannel();

      // Waits for the count to *reach* two rather than for the next presence frame: the room
      // also broadcast a count of one on this socket's own join, which may still be in flight.
      const presence = nextPresenceOf(socket, 2);
      await join(name, BOB);

      await expect(presence).resolves.toMatchObject({ type: 'presence', participants: 2 });
    });
  });

  describe('messaging', () => {
    it('persists a message and broadcasts it to everybody in the channel', async () => {
      const { name, socket: alice } = await joinFreshChannel();
      const bob = await join(name, BOB);

      const delivered = nextFrameOfType(bob, 'message');
      alice.send(JSON.stringify({ body: 'ship it' }));

      expect(await delivered).toMatchObject({
        type: 'message',
        message: { author: ALICE, body: 'ship it' }
      });
      expect(await storedMessages(name)).toEqual([{ author: ALICE, body: 'ship it' }]);
    });

    it('echoes the message back to its sender rather than assuming a local copy', async () => {
      const { socket } = await joinFreshChannel();

      const echoed = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'hello' }));

      expect(await echoed).toMatchObject({ message: { author: ALICE, body: 'hello' } });
    });

    // The authorship guarantee. The author is read from the socket attachment the Worker set,
    // so a participant cannot post as somebody else even controlling every byte they send.
    it('attributes a message to the connection’s identity, never to the frame', async () => {
      const { name, socket } = await joinFreshChannel(BOB);

      socket.send(JSON.stringify({ body: 'hello', author: ALICE }));
      // Rejected outright, because the wire format has no author field at all.
      expect(await nextFrameOfType(socket, 'error')).toMatchObject({ type: 'error' });
      expect(await storedMessages(name)).toEqual([]);

      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'hello' }));
      expect(await delivered).toMatchObject({ message: { author: BOB } });
    });

    // The other half of the authorship guarantee, at the transport layer. The identity reaches
    // the room in a header, so a client might try to set that header itself; the Worker strips
    // any inbound copy before forwarding (see `src/worker/infrastructure/room-protocol.ts`).
    it('ignores an identity header the client tried to smuggle in', async () => {
      const name = await createChannel(uniqueChannelName());
      const socket = await openSocket(name, BOB, { 'X-Chat-Identity': ALICE });
      openSockets.add(socket);
      await nextFrameOfType(socket, 'history');

      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'who am i' }));

      expect(await delivered).toMatchObject({ message: { author: BOB } });
      expect(await storedMessages(name)).toEqual([{ author: BOB, body: 'who am i' }]);
    });

    it('trims the stored body', async () => {
      const { name, socket } = await joinFreshChannel();

      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: '   padded   ' }));
      await delivered;

      expect(await storedMessages(name)).toEqual([{ author: ALICE, body: 'padded' }]);
    });

    it('preserves the order messages were accepted in', async () => {
      const { name, socket } = await joinFreshChannel();

      for (const body of ['first', 'second', 'third']) {
        const delivered = nextFrameOfType(socket, 'message');
        socket.send(JSON.stringify({ body }));
        await delivered;
      }

      expect((await storedMessages(name)).map((entry) => entry.body)).toEqual([
        'first',
        'second',
        'third'
      ]);
    });
  });

  describe('rejected frames', () => {
    // A rejected message is reported to its sender and to nobody else, and the connection stays
    // open: one bad message is not a reason to disconnect a participant.
    it.each([
      ['an empty body', JSON.stringify({ body: '   ' })],
      ['a non-string body', JSON.stringify({ body: 42 })],
      ['a missing body', JSON.stringify({})],
      ['an over-long body', JSON.stringify({ body: 'a'.repeat(2_001) })],
      ['control characters', JSON.stringify({ body: 'bad\u0000text' })],
      ['malformed JSON', '{"body":'],
      ['a bare string', '"hello"']
    ])('rejects %s without persisting it', async (_label, payload) => {
      const { name, socket } = await joinFreshChannel();

      const rejection = nextFrameOfType(socket, 'error');
      socket.send(payload);

      expect(await rejection).toMatchObject({ type: 'error' });
      expect(await storedMessages(name)).toEqual([]);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    it('does not broadcast a rejected message to other participants', async () => {
      const { name, socket: alice } = await joinFreshChannel();
      const bob = await join(name, BOB);

      const rejection = nextFrameOfType(alice, 'error');
      alice.send(JSON.stringify({ body: '' }));
      await rejection;

      // The rejection reached its sender; nothing reached anybody else, and nothing was stored.
      await expectNoFrameOfType(bob, 'message');
      await expectNoFrameOfType(bob, 'error');
      expect(await storedMessages(name)).toEqual([]);
      expect(bob.readyState).toBe(WebSocket.OPEN);
    });

    // Rejections carry the domain's own user-safe `detail`, so a failure over the socket reads
    // the same as the equivalent failure over HTTP.
    it('reports the domain’s explanation rather than a generic failure', async () => {
      const { socket } = await joinFreshChannel();

      const rejection = nextFrameOfType(socket, 'error');
      socket.send(JSON.stringify({ body: 42 }));

      expect(await rejection).toMatchObject({ detail: expect.stringContaining('body') });
    });
  });

  // Each channel name is a different Durable Object, so isolation is structural rather than
  // enforced by a query predicate — the opposite of the sibling `todo` demo.
  describe('channel isolation', () => {
    it('does not deliver one channel’s messages to another', async () => {
      const first = await joinFreshChannel();
      const second = await joinFreshChannel();

      const delivered = nextFrameOfType(first.socket, 'message');
      first.socket.send(JSON.stringify({ body: 'only here' }));
      await delivered;

      // Two independent checks, because they can fail for different reasons: the second room's
      // storage proves the message was never persisted there, and its socket proves nothing was
      // fanned out to it even transiently.
      expect(await storedMessages(second.name)).toEqual([]);
      await expectNoFrameOfType(second.socket, 'message');
    });

    it('counts participants separately for each channel', async () => {
      const busy = await joinFreshChannel();
      const quiet = await joinFreshChannel();

      // A second participant joins only the busy channel. Waiting for that channel to report
      // the new count is what makes the assertion below deterministic: by the time it resolves,
      // any broadcast the join was going to cause has already happened.
      const busyPresence = nextPresenceOf(busy.socket, 2);
      await join(busy.name, BOB);
      await busyPresence;

      // The quiet channel is a different Durable Object, so it saw none of that.
      await expectNoFrameOfType(quiet.socket, 'presence');
    });
  });

  describe('durability', () => {
    // History comes from the room's own storage, not from any client's memory, so a participant
    // who reconnects recovers the real conversation rather than a blank room.
    it('replays stored history to a participant who joins later', async () => {
      const { name, socket } = await joinFreshChannel();
      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'said earlier' }));
      await delivered;

      const latecomer = await openSocket(name, BOB);
      openSockets.add(latecomer);
      const history = await nextFrameOfType(latecomer, 'history');

      expect(history).toMatchObject({
        type: 'history',
        messages: [expect.objectContaining({ author: ALICE, body: 'said earlier' })]
      });
    });

    // The room is reconstructed from storage after eviction, which is exactly what happens when
    // a hibernating channel wakes up.
    it('survives eviction of the Durable Object', async () => {
      const { name, socket } = await joinFreshChannel();
      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'before eviction' }));
      await delivered;

      await evictAllDurableObjects({ webSockets: 'close' });
      openSockets.clear();

      const rejoined = await openSocket(name, ALICE);
      openSockets.add(rejoined);
      const history = await nextFrameOfType(rejoined, 'history');

      expect(history).toMatchObject({
        messages: [expect.objectContaining({ body: 'before eviction' })]
      });
    });
  });

  describe('channel removal', () => {
    it('warns every participant and closes their sockets with the removal code', async () => {
      const { name, socket: alice } = await joinFreshChannel();
      const bob = await join(name, BOB);

      const aliceWarned = nextFrameOfType(alice, 'channel_removed');
      const bobClosed = nextClose(bob);
      const response = await send(await requestAs(`/api/channels/${name}`, { method: 'DELETE' }));

      expect(response.status).toBe(204);
      expect(await aliceWarned).toEqual({ type: 'channel_removed' });
      expect((await bobClosed).code).toBe(CHANNEL_REMOVED_CLOSE_CODE);
    });

    it('erases the conversation', async () => {
      const { name, socket } = await joinFreshChannel();
      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'will be erased' }));
      await delivered;

      await send(await requestAs(`/api/channels/${name}`, { method: 'DELETE' }));

      expect(await storedMessages(name)).toEqual([]);
    });

    // The room recreates its schema immediately after erasing, so a channel recreated under the
    // same name works on its very first write rather than depending on eviction having happened.
    it('leaves a recreated channel of the same name empty and usable', async () => {
      const { name, socket } = await joinFreshChannel();
      const delivered = nextFrameOfType(socket, 'message');
      socket.send(JSON.stringify({ body: 'from the first incarnation' }));
      await delivered;

      await send(await requestAs(`/api/channels/${name}`, { method: 'DELETE' }));
      await createChannel(name);

      const rejoined = await openSocket(name, ALICE);
      openSockets.add(rejoined);
      expect(await nextFrameOfType(rejoined, 'history')).toEqual({
        type: 'history',
        messages: []
      });

      const echoed = nextFrameOfType(rejoined, 'message');
      rejoined.send(JSON.stringify({ body: 'from the second' }));
      expect(await echoed).toMatchObject({ message: { body: 'from the second' } });
    });
  });

  describe('presence', () => {
    it('reports a departure to the remaining participants', async () => {
      const { name, socket: alice } = await joinFreshChannel();
      const arrival = nextPresenceOf(alice, 2);
      const bob = await join(name, BOB);
      await arrival;

      const departure = nextPresenceOf(alice, 1);
      bob.close();

      await expect(departure).resolves.toMatchObject({ type: 'presence', participants: 1 });
    });
  });
});
