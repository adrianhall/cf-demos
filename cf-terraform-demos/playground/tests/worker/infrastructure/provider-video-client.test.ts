/**
 * @file Tests for retrieving a provider's generated video into storage. Three properties carry the
 *   weight here, and each one would be a real defect if it regressed: the body is never buffered
 *   whole, the bytes are identified before anything is written, and a refusal leaves no object
 *   behind. The last is the subtle one — a client that sniffed _after_ opening the write would
 *   leave a partial object for every provider that answered with an error page, and those orphans
 *   would then need collecting.
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_BYTES } from '../../../src/shared/create-video';
import type { VideoStoragePort } from '../../../src/worker/application/ports/video-storage-port';
import { GENERATED_VIDEO_PREFIX } from '../../../src/worker/domain/media-job-identity';
import { ProviderVideoClient } from '../../../src/worker/infrastructure/media/provider-video-client';

/**
 * Hosts the reviewed descriptor approves.
 */
const HOSTS = ['media.pixverse.ai'];

/**
 * A valid storage key.
 */
const KEY = `${GENERATED_VIDEO_PREFIX}abc123`;

/**
 * Builds MP4-looking bytes of the requested length.
 *
 * @param length Total bytes.
 * @returns A buffer whose head identifies as MP4.
 */
function mp4Bytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
  return bytes;
}

/**
 * Builds a response streaming the given bytes in fixed-size chunks.
 *
 * Chunked deliberately: a single-chunk body would not exercise the head-then-remainder path that
 * keeps the whole video out of memory.
 *
 * @param bytes Body content.
 * @param chunkSize Bytes per chunk.
 * @returns A streaming `Response`.
 */
function streamingResponse(bytes: Uint8Array, chunkSize = 256): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
  return new Response(stream, { status: 200 });
}

/**
 * Builds a storage double that records what it was asked to store.
 *
 * @returns The port and the recorded calls.
 */
function recordingStorage(): {
  port: VideoStoragePort;
  stored: { key: string; mediaType: string; byteLength: number }[];
} {
  const stored: { key: string; mediaType: string; byteLength: number }[] = [];
  const port: VideoStoragePort = {
    async store(key, body, mediaType) {
      // Drained the way R2 would, which is what runs the bounded stream and exercises the cap.
      let byteLength = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.length;
      }
      stored.push({ key, mediaType, byteLength });
      return { mediaType, byteLength };
    },
    async read() {
      return undefined;
    },
    async readHead() {
      return undefined;
    },
    async delete() {
      return undefined;
    },
    async listExpired() {
      return [];
    }
  };
  return { port, stored };
}

describe('ProviderVideoClient URL policy', () => {
  it.each([
    ['an unapproved host', 'https://evil.example.com/clip.mp4'],
    ['plain HTTP', 'http://media.pixverse.ai/clip.mp4'],
    ['embedded credentials', 'https://user:pass@media.pixverse.ai/clip.mp4'],
    ['an explicit port', 'https://media.pixverse.ai:8443/clip.mp4'],
    ['an unparseable URL', 'not-a-url']
  ])('refuses %s', async (_label, url) => {
    // The returned URL is fetched server-side, so a model free to name any host would make this
    // Worker a general-purpose fetcher.
    const { port, stored } = recordingStorage();
    const client = new ProviderVideoClient({ storage: port, fetch: vi.fn() });

    await expect(client.fetchAndStore(url, HOSTS, KEY)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });
    expect(stored).toHaveLength(0);
  });

  it('does not follow a redirect off the approved host', async () => {
    // Following one would leave the allowlist behind, which is the whole point of having it.
    const { port } = recordingStorage();
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 302 })
    );
    const client = new ProviderVideoClient({ storage: port, fetch: fetchSpy });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });

    const init = fetchSpy.mock.calls[0]?.[1] as { redirect: string };
    expect(init.redirect).toBe('manual');
  });
});

describe('ProviderVideoClient content policy', () => {
  it('stores a video whose bytes identify as MP4', async () => {
    const { port, stored } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(mp4Bytes(4_096)))
    });

    const result = await client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY);

    expect(result.mediaType).toBe('video/mp4');
    // The whole body, not the body minus its sniffed head — the head is re-emitted ahead of the
    // remainder, and a regression there would silently truncate every stored video.
    expect(result.byteLength).toBe(4_096);
    expect(stored[0]?.byteLength).toBe(4_096);
  });

  it('stores a video shorter than the sniff window', async () => {
    // The head read stops at end-of-stream as well as at the window, so a small clip must still be
    // identified rather than left waiting for bytes that never arrive.
    const { port } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(mp4Bytes(64), 16))
    });

    const result = await client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY);

    expect(result.byteLength).toBe(64);
  });

  it('refuses an HTML error page and stores nothing', async () => {
    // A provider answering a success status with an error page is a real behaviour. Refusing before
    // the write opens is what keeps it from leaving a partial object behind.
    const { port, stored } = recordingStorage();
    const html = new TextEncoder().encode('<!DOCTYPE html><html>Gateway Timeout</html>');
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(html))
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });
    expect(stored).toHaveLength(0);
  });

  it('refuses a JSON fault document and stores nothing', async () => {
    const { port, stored } = recordingStorage();
    const json = new TextEncoder().encode('{"error":"quota exceeded"}');
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(json))
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });
    expect(stored).toHaveLength(0);
  });

  it('refuses a failed response', async () => {
    const { port } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => new Response('nope', { status: 500 }))
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });
  });

  it('refuses an empty body', async () => {
    const { port } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => new Response(null, { status: 200 }))
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });
  });

  it('refuses a body whose declared length exceeds the cap', async () => {
    const { port, stored } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(
        async () =>
          new Response(streamingResponse(mp4Bytes(1_024)).body, {
            status: 200,
            headers: { 'content-length': String(MAX_VIDEO_BYTES + 1) }
          })
      )
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toMatchObject({ problemDetails: { status: 502 } });
    expect(stored).toHaveLength(0);
  });

  it('aborts a body that exceeds the cap while streaming', async () => {
    // A declared length is the provider's claim about its own body, and a body may exceed it. The
    // cap is therefore enforced chunk by chunk, which also aborts the write in progress rather than
    // leaving an oversized object.
    const { port } = recordingStorage();
    let emitted = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = emitted === 0 ? mp4Bytes(1_024) : new Uint8Array(1_024 * 1_024);
        emitted += chunk.length;
        controller.enqueue(chunk);
      }
    });
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => new Response(endless, { status: 200 }))
    });

    await expect(
      client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY)
    ).rejects.toThrow();
  });

  it('stores under the key it was given', async () => {
    const { port, stored } = recordingStorage();
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(mp4Bytes(512)))
    });

    await client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY);

    expect(stored[0]?.key).toBe(KEY);
  });

  it('hands storage a stream rather than a buffer', async () => {
    // The property that keeps a 100 MB video out of a 128 MB isolate. A regression here would not
    // fail any functional assertion — it would just start running out of memory on large videos.
    const seen: unknown[] = [];
    const port: VideoStoragePort = {
      async store(_key, body, mediaType) {
        seen.push(body);
        await body.getReader().read();
        return { mediaType, byteLength: 1 };
      },
      async read() {
        return undefined;
      },
      async readHead() {
        return undefined;
      },
      async delete() {
        return undefined;
      },
      async listExpired() {
        return [];
      }
    };
    const client = new ProviderVideoClient({
      storage: port,
      fetch: vi.fn(async () => streamingResponse(mp4Bytes(2_048)))
    });

    await client.fetchAndStore('https://media.pixverse.ai/clip.mp4', HOSTS, KEY);

    expect(seen[0]).toBeInstanceOf(ReadableStream);
  });
});
