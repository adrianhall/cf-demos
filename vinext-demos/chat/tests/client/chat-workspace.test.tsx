import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHANNEL_REMOVED_CLOSE_CODE } from '../../src/chat-protocol';
import { ChatWorkspace } from '../../src/ui/chat-workspace';
import { FakeWebSocket, installFakeWebSocket, mostRecentSocket } from './support/fake-websocket';

const GENERAL = {
  name: 'general',
  createdBy: 'system',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const RANDOM = {
  name: 'random',
  createdBy: 'system',
  createdAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Build a JSON response for a mocked same-origin API call.
 *
 * @param value Body to serialize.
 * @param status HTTP status to report.
 * @returns A `Response` shaped like the Worker's.
 */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

/**
 * Build an RFC 9457 problem-details response, as the Worker returns on failure.
 *
 * @param detail User-safe explanation.
 * @param status HTTP status to report.
 * @returns A problem-details `Response`.
 */
function problemResponse(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail, status }), {
    headers: { 'Content-Type': 'application/problem+json' },
    status
  });
}

/**
 * The stubbed `fetch`, typed by its real signature rather than as a bare `vi.fn()`.
 *
 * The explicit type is load-bearing: an untyped mock is inferred to return `void`, so every
 * `mockImplementation` returning a promise below would be reported as a misused promise by
 * type-aware lint even though it is exactly what `fetch` does.
 */
let fetchMock: Mock<(path: string, init?: RequestInit) => Promise<Response>>;

/**
 * Route a mocked request by path, so a test states what the API contains rather than the order in
 * which the component happens to call it.
 *
 * The component issues its identity and directory requests concurrently, so a queue of
 * `mockResolvedValueOnce` values would be order-dependent in a way that has nothing to do with the
 * behaviour under test.
 *
 * @param channels Directory contents to report from `/api/channels`.
 */
function respondWith(channels: unknown[]): void {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/me') {
      return Promise.resolve(jsonResponse({ email: 'alice@example.com' }));
    }
    if (path === '/api/channels' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse({ channels }));
    }
    return Promise.resolve(jsonResponse({}, 204));
  });
}

/**
 * Render the workspace and wait for it to finish its initial load and connect.
 *
 * @returns The opened fake socket, already handshaken.
 */
async function renderConnected(): Promise<FakeWebSocket> {
  render(<ChatWorkspace />);
  await screen.findByRole('button', { name: 'general' });
  const socket = mostRecentSocket();
  act(() => socket.simulateOpen());
  return socket;
}

beforeEach(() => {
  installFakeWebSocket();
  fetchMock = vi.fn();
  respondWith([GENERAL, RANDOM]);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatWorkspace', () => {
  describe('the channel directory', () => {
    it('lists every channel in the shared workspace', async () => {
      render(<ChatWorkspace />);

      const list = await screen.findByRole('list', { name: 'Channel list' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'general' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'random' })).toBeVisible();
    });

    // `general` is seeded by the migration and is the conventional default, so a participant
    // arrives in a conversation rather than at an empty pane they have to click out of.
    it('joins general by default', async () => {
      await renderConnected();

      expect(mostRecentSocket().url).toContain('/api/channels/general/socket');
      expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute(
        'aria-current',
        'true'
      );
    });

    it('falls back to the first channel when there is no general', async () => {
      respondWith([RANDOM]);
      render(<ChatWorkspace />);

      await screen.findByRole('button', { name: 'random' });
      expect(mostRecentSocket().url).toContain('/api/channels/random/socket');
    });

    it('shows an empty state and connects nothing when there are no channels', async () => {
      respondWith([]);
      render(<ChatWorkspace />);

      expect(
        await screen.findByText(
          'No channel selected. Add a channel in the sidebar to start a conversation.'
        )
      ).toBeVisible();
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it('connects to a channel chosen in the sidebar', async () => {
      const user = userEvent.setup();
      await renderConnected();

      await user.click(screen.getByRole('button', { name: 'random' }));

      expect(mostRecentSocket().url).toContain('/api/channels/random/socket');
    });

    it('reports a directory that cannot be loaded', async () => {
      fetchMock.mockImplementation((path: string) =>
        path === '/api/me'
          ? Promise.resolve(jsonResponse({ email: 'alice@example.com' }))
          : Promise.resolve(problemResponse('The directory is unavailable.', 503))
      );
      render(<ChatWorkspace />);

      expect(await screen.findByRole('alert')).toHaveTextContent('The directory is unavailable.');
    });
  });

  describe('creating a channel', () => {
    it('creates a channel, re-reads the directory, and joins it', async () => {
      const created = { name: 'deploys', createdBy: 'alice@example.com', createdAt: 'now' };
      const user = userEvent.setup();
      await renderConnected();

      fetchMock.mockImplementation((_path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ channel: created }, 201));
        }
        return Promise.resolve(jsonResponse({ channels: [created, GENERAL, RANDOM] }));
      });
      await user.type(screen.getByLabelText('New channel name'), 'deploys');
      await user.click(screen.getByRole('button', { name: 'Add channel' }));

      await waitFor(() => expect(mostRecentSocket().url).toContain('/api/channels/deploys/socket'));
      expect(fetchMock).toHaveBeenCalledWith('/api/channels', {
        body: JSON.stringify({ name: 'deploys' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
    });

    // The server owns normalization, so the channel joined must be the name it stored rather than
    // the text that was typed — otherwise a participant would join a channel that does not exist.
    it('joins the server-normalized name rather than the submitted text', async () => {
      const user = userEvent.setup();
      await renderConnected();

      fetchMock.mockImplementation((_path: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.resolve(
              jsonResponse(
                { channel: { name: 'deploys', createdBy: 'alice@example.com', createdAt: 'now' } },
                201
              )
            )
          : Promise.resolve(jsonResponse({ channels: [GENERAL] }))
      );
      await user.type(screen.getByLabelText('New channel name'), '  DePloys  ');
      await user.click(screen.getByRole('button', { name: 'Add channel' }));

      await waitFor(() => expect(mostRecentSocket().url).toContain('/api/channels/deploys/socket'));
    });

    it('reports a rejected channel name without clearing the conversation', async () => {
      const user = userEvent.setup();
      await renderConnected();

      fetchMock.mockImplementation((_path: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.resolve(problemResponse('A channel named "general" already exists.', 409))
          : Promise.resolve(jsonResponse({ channels: [GENERAL, RANDOM] }))
      );
      await user.type(screen.getByLabelText('New channel name'), 'general');
      await user.click(screen.getByRole('button', { name: 'Add channel' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'A channel named "general" already exists.'
      );
    });

    // Almost always an accidental Enter press rather than a mistake worth reporting.
    it('does not submit a whitespace-only name', async () => {
      const user = userEvent.setup();
      await renderConnected();
      const callsBefore = fetchMock.mock.calls.length;

      await user.type(screen.getByLabelText('New channel name'), '   ');
      await user.click(screen.getByRole('button', { name: 'Add channel' }));

      expect(fetchMock.mock.calls).toHaveLength(callsBefore);
    });
  });

  describe('removing a channel', () => {
    it('removes a channel and moves to a remaining one', async () => {
      const user = userEvent.setup();
      await renderConnected();

      fetchMock.mockImplementation((_path: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? Promise.resolve(new Response(null, { status: 204 }))
          : Promise.resolve(jsonResponse({ channels: [RANDOM] }))
      );
      await user.click(screen.getByRole('button', { name: 'Remove channel: general' }));

      await waitFor(() => expect(mostRecentSocket().url).toContain('/api/channels/random/socket'));
      expect(fetchMock).toHaveBeenCalledWith('/api/channels/general', { method: 'DELETE' });
    });

    it('reports a removal the API refused', async () => {
      const user = userEvent.setup();
      await renderConnected();

      fetchMock.mockImplementation((_path: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? Promise.resolve(problemResponse('Channel not found.', 404))
          : Promise.resolve(jsonResponse({ channels: [GENERAL, RANDOM] }))
      );
      await user.click(screen.getByRole('button', { name: 'Remove channel: general' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Channel not found.');
    });

    // A removal performed by *another* participant arrives only as a close code, and must behave
    // exactly like one performed locally: explain it, then move to a channel that still exists.
    it('recovers when the viewed channel is removed by somebody else', async () => {
      const socket = await renderConnected();
      respondWith([RANDOM]);

      act(() => socket.simulateClose(CHANNEL_REMOVED_CLOSE_CODE));

      expect(await screen.findByRole('alert')).toHaveTextContent('Channel "general" was removed.');
      await waitFor(() => expect(mostRecentSocket().url).toContain('/api/channels/random/socket'));
    });
  });

  describe('the conversation', () => {
    it('replays history and shows each message with its author', async () => {
      const socket = await renderConnected();

      act(() =>
        socket.simulateMessage({
          type: 'history',
          messages: [
            {
              id: 1,
              author: 'bob@example.com',
              body: 'Morning',
              createdAt: '2026-01-02T09:00:00.000Z'
            }
          ]
        })
      );

      expect(await screen.findByText('Morning')).toBeVisible();
      expect(screen.getByText('bob@example.com')).toBeVisible();
    });

    it('appends a broadcast message', async () => {
      const socket = await renderConnected();
      act(() => socket.simulateMessage({ type: 'history', messages: [] }));

      act(() =>
        socket.simulateMessage({
          type: 'message',
          message: {
            id: 7,
            author: 'bob@example.com',
            body: 'Deploying now',
            createdAt: '2026-01-02T09:05:00.000Z'
          }
        })
      );

      expect(await screen.findByText('Deploying now')).toBeVisible();
    });

    it('reports the participant count', async () => {
      const socket = await renderConnected();

      act(() => socket.simulateMessage({ type: 'presence', participants: 2 }));

      expect(await screen.findByText('2 participants')).toBeVisible();
    });

    it('shows a rejection the room reported', async () => {
      const socket = await renderConnected();

      act(() => socket.simulateMessage({ type: 'error', detail: 'body must be a string.' }));

      expect(await screen.findByText('body must be a string.')).toBeVisible();
    });

    it('ignores a frame it cannot parse', async () => {
      const socket = await renderConnected();
      act(() => socket.simulateMessage({ type: 'history', messages: [] }));

      act(() => socket.simulateMessage('not json'));

      expect(
        await screen.findByText('No messages yet. Be the first to say something.')
      ).toBeVisible();
    });
  });

  describe('sending a message', () => {
    it('sends only a body, never an author', async () => {
      const user = userEvent.setup();
      const socket = await renderConnected();

      await user.type(screen.getByLabelText('Message'), 'hello');
      await user.click(screen.getByRole('button', { name: 'Send message' }));

      expect(socket.sent).toEqual([JSON.stringify({ body: 'hello' })]);
      // The wire protocol has no author field and the domain rejects a payload that adds one, so
      // a client that tried to assert authorship would be refused rather than believed.
      expect(socket.sent[0]).not.toContain('author');
    });

    it('clears the field after sending', async () => {
      const user = userEvent.setup();
      await renderConnected();

      const field = screen.getByLabelText('Message');
      await user.type(field, 'hello');
      await user.click(screen.getByRole('button', { name: 'Send message' }));

      await waitFor(() => expect(field).toHaveValue(''));
    });

    it('does not send a whitespace-only message', async () => {
      const user = userEvent.setup();
      const socket = await renderConnected();

      await user.type(screen.getByLabelText('Message'), '   ');
      await user.click(screen.getByRole('button', { name: 'Send message' }));

      expect(socket.sent).toEqual([]);
    });

    // Disabling the composer while disconnected is what stops a participant composing into a
    // connection that cannot deliver it.
    it('disables the composer until the connection is open', async () => {
      render(<ChatWorkspace />);
      await screen.findByRole('button', { name: 'general' });

      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      act(() => mostRecentSocket().simulateOpen());

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
      );
    });
  });

  describe('the connection', () => {
    it('explains a dropped connection while it retries', async () => {
      const socket = await renderConnected();

      act(() => socket.simulateClose(1_006));

      expect(await screen.findByText('Connection lost — retrying…')).toBeVisible();
    });

    // A removed channel is terminal: retrying would loop forever against a channel that no
    // longer exists, which is why it is distinguished from an ordinary drop by its close code.
    it('does not retry after a channel removal', async () => {
      const socket = await renderConnected();
      respondWith([]);
      const socketsBefore = FakeWebSocket.instances.length;

      act(() => socket.simulateClose(CHANNEL_REMOVED_CLOSE_CODE));
      await screen.findByRole('alert');

      expect(FakeWebSocket.instances).toHaveLength(socketsBefore);
    });

    // The browser has no trustworthy copy of its own identity, so the value compared against is
    // the Worker's verified view from `/api/me`.
    it('marks the reader’s own messages using the verified identity', async () => {
      const socket = await renderConnected();

      act(() =>
        socket.simulateMessage({
          type: 'history',
          messages: [
            { id: 1, author: 'alice@example.com', body: 'Mine', createdAt: '2026-01-02T09:00:00Z' },
            { id: 2, author: 'bob@example.com', body: 'Theirs', createdAt: '2026-01-02T09:01:00Z' }
          ]
        })
      );

      const mine = (await screen.findByText('Mine')).closest('article');
      const theirs = screen.getByText('Theirs').closest('article');
      expect(mine).toHaveClass('own');
      expect(theirs).not.toHaveClass('own');
    });

    it('never sends an identity of its own with a request', async () => {
      await renderConnected();

      for (const [path, init] of fetchMock.mock.calls) {
        // `/api/me` asks the Worker who the caller is; it does not assert one.
        if (path === '/api/me') {
          continue;
        }
        expect(path).not.toMatch(/user|email|author/iu);
        const body = init?.body;
        expect(typeof body === 'string' ? body : '').not.toMatch(/user|email|author/iu);
      }
    });
  });
});
