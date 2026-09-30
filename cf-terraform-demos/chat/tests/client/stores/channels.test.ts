import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelsStore } from '../../../src/client/stores/channels';

/**
 * Build a channel as the API returns one.
 *
 * @param name Channel name.
 * @returns A complete channel record.
 */
function channel(name: string) {
  return { name, createdBy: 'alice@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * Build a successful JSON response.
 *
 * @param body Value to serialize.
 * @param status HTTP status.
 * @returns A `Response` the store can consume.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Build an RFC 9457 problem response.
 *
 * @param status HTTP status.
 * @param detail User-safe explanation.
 * @returns A problem-details `Response`.
 */
function problemResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' }
  });
}

describe('useChannelsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('load', () => {
    it('stores the directory the API returned', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ channels: [channel('general')] }))
      );

      const channels = useChannelsStore();
      await channels.load();

      expect(channels.channels.map((entry) => entry.name)).toEqual(['general']);
      expect(channels.isEmpty).toBe(false);
      expect(channels.error).toBeNull();
    });

    // A failed initial load has no interaction to report against, so the store records it
    // rather than throwing into an unhandled rejection at mount time.
    it('records a failure rather than throwing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(problemResponse(401, 'Authentication required.'))
      );

      const channels = useChannelsStore();
      await channels.load();

      expect(channels.error).toBe('Authentication required.');
      expect(channels.isEmpty).toBe(true);
    });

    it('clears loading even when the request fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

      const channels = useChannelsStore();
      await channels.load();

      expect(channels.loading).toBe(false);
    });
  });

  describe('create', () => {
    // The directory is shared, so the server's view — including its normalization and ordering —
    // is the only correct one to render after a mutation.
    it('re-reads the directory instead of patching local state', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ channel: channel('deploys') }, 201))
        .mockResolvedValueOnce(
          jsonResponse({ channels: [channel('deploys'), channel('general')] })
        );
      vi.stubGlobal('fetch', fetchMock);

      const channels = useChannelsStore();
      await channels.create('Deploys');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(channels.channels.map((entry) => entry.name)).toEqual(['deploys', 'general']);
    });

    // Returning the server's record lets the caller join the normalized name rather than the
    // text that was typed.
    it('returns the API-confirmed channel', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(jsonResponse({ channel: channel('deploys') }, 201))
          .mockResolvedValueOnce(jsonResponse({ channels: [channel('deploys')] }))
      );

      expect(await useChannelsStore().create('  Deploys  ')).toMatchObject({ name: 'deploys' });
    });

    // Mutations throw so the view can report against the specific interaction that failed.
    it('throws a conflict message the view can show', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(problemResponse(409, 'A channel named "general" already exists.'))
      );

      await expect(useChannelsStore().create('general')).rejects.toThrowError(
        'A channel named "general" already exists.'
      );
    });

    it('throws a validation message the view can show', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(problemResponse(422, 'name must be a string.'))
      );

      await expect(useChannelsStore().create('!!')).rejects.toThrowError('name must be a string.');
    });
  });

  describe('remove', () => {
    it('re-reads the directory after removing', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse({ channels: [channel('general')] }));
      vi.stubGlobal('fetch', fetchMock);

      const channels = useChannelsStore();
      await channels.remove('deploys');

      expect(channels.channels.map((entry) => entry.name)).toEqual(['general']);
    });

    it('percent-encodes the channel name in the path', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse({ channels: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await useChannelsStore().remove('a-b');

      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/channels/a-b');
    });

    it('throws when the channel is already gone', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(404, 'Channel not found.')));

      await expect(useChannelsStore().remove('missing')).rejects.toThrowError('Channel not found.');
    });
  });
});
