/**
 * @file Tests for R2-backed video storage, and for the prefix containment that makes this demo's
 *   claim about the bucket true. The claim is that the bucket holds generated video and nothing
 *   else. A comment cannot enforce that, and nor can discipline at each call site — so every method
 *   refuses a key outside the prefix, and these tests assert the refusal. The pairing matters for a
 *   later phase: the scheduled reaper will delete only what lives under this prefix, so an object
 *   written outside it would be one nothing ever collects.
 */

import { describe, expect, it, vi } from 'vitest';
import { GENERATED_VIDEO_PREFIX } from '../../../src/worker/domain/media-job-identity';
import { R2VideoStorage } from '../../../src/worker/infrastructure/media/r2-video-storage';

/**
 * A valid key under the generated-video prefix.
 */
const KEY = `${GENERATED_VIDEO_PREFIX}abc123`;

/**
 * Builds a single-chunk stream.
 *
 * @param bytes Content to emit.
 * @returns A readable stream of those bytes.
 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * Builds an R2 bucket double.
 *
 * @param overrides Methods to replace.
 * @returns An `R2Bucket`-shaped object.
 */
function bucket(overrides: Record<string, unknown> = {}) {
  return {
    put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
      let size = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
      }
      return { key, size };
    }),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    ...overrides
  } as unknown as R2Bucket;
}

describe('R2VideoStorage key containment', () => {
  it.each([
    ['a key with no prefix', 'clip.mp4'],
    ['a key under another prefix', 'uploads/clip.mp4'],
    ['the bare prefix itself', GENERATED_VIDEO_PREFIX],
    ['a traversal-looking key', '../secrets/clip.mp4']
  ])('refuses to store under %s', async (_label, key) => {
    const storage = new R2VideoStorage(bucket());

    await expect(
      storage.store(key, streamOf(new Uint8Array([1, 2, 3])), 'video/mp4')
    ).rejects.toThrow();
  });

  it('refuses to delete outside the prefix', async () => {
    // The guard that matters most for a future bucket user: a key outside this prefix must not be
    // deletable through this port, so a job that predates another feature cannot collect its data.
    const storage = new R2VideoStorage(bucket());

    await expect(storage.delete('uploads/something')).rejects.toThrow();
  });

  it('refuses to read outside the prefix', async () => {
    const storage = new R2VideoStorage(bucket());

    await expect(storage.read('uploads/something')).rejects.toThrow();
    await expect(storage.readHead('uploads/something', 16)).rejects.toThrow();
  });

  it('never passes a non-prefixed key to the bucket', async () => {
    // The refusal has to happen before the binding is touched, not after: a guard that rejected
    // only the return value would already have performed the operation.
    const spy = bucket();
    const storage = new R2VideoStorage(spy);

    await expect(storage.delete('uploads/x')).rejects.toThrow();

    expect((spy.delete as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe('R2VideoStorage.store', () => {
  it('streams the body through rather than buffering it', async () => {
    // The binding receives the stream itself. If this ever became a buffer, a 100 MB video would
    // occupy most of the isolate's 128 MB budget.
    const spy = bucket();
    const storage = new R2VideoStorage(spy);

    await storage.store(KEY, streamOf(new Uint8Array(4_096)), 'video/mp4');

    const call = (spy.put as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[1]).toBeInstanceOf(ReadableStream);
  });

  it('records the sniffed type as the object’s content type', async () => {
    const spy = bucket();
    const storage = new R2VideoStorage(spy);

    await storage.store(KEY, streamOf(new Uint8Array(16)), 'video/webm');

    const options = (spy.put as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2] as {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    };
    expect(options.httpMetadata.contentType).toBe('video/webm');
    // Kept separately as well, so a future change to how objects are written cannot silently turn a
    // provider-declared type into one this demo appears to have verified.
    expect(options.customMetadata['sniffedType']).toBe('video/webm');
  });

  it('reports the stored size', async () => {
    const storage = new R2VideoStorage(bucket());

    const stored = await storage.store(KEY, streamOf(new Uint8Array(2_048)), 'video/mp4');

    expect(stored).toEqual({ mediaType: 'video/mp4', byteLength: 2_048 });
  });

  it('fails loudly when R2 declines the write', async () => {
    const storage = new R2VideoStorage(bucket({ put: vi.fn(async () => null) }));

    await expect(storage.store(KEY, streamOf(new Uint8Array(8)), 'video/mp4')).rejects.toThrow();
  });
});

describe('R2VideoStorage.read', () => {
  it('reports absence rather than throwing', async () => {
    const storage = new R2VideoStorage(bucket());

    expect(await storage.read(KEY)).toBe(undefined);
    expect(await storage.readHead(KEY, 16)).toBe(undefined);
  });

  it('passes a requested range to the binding', async () => {
    // Range support is the reason the video is in storage at all: a `<video>` element seeks by
    // asking for byte ranges, which a base64 JSON payload cannot answer.
    const spy = bucket({
      get: vi.fn(async () => ({
        body: streamOf(new Uint8Array(100)),
        size: 1_000,
        range: { offset: 200, length: 100 },
        httpMetadata: { contentType: 'video/mp4' },
        customMetadata: { sniffedType: 'video/mp4' }
      }))
    });
    const storage = new R2VideoStorage(spy);

    const body = await storage.read(KEY, { offset: 200, length: 100 });

    const options = (spy.get as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      range: { offset: number; length: number };
    };
    expect(options.range).toEqual({ offset: 200, length: 100 });
    // The total is the whole object's size regardless of the range, which is what a
    // `Content-Range` header needs.
    expect(body?.byteLength).toBe(1_000);
    expect(body?.rangeOffset).toBe(200);
    expect(body?.rangeLength).toBe(100);
  });

  it('reports the whole object when no range was asked for', async () => {
    const storage = new R2VideoStorage(
      bucket({
        get: vi.fn(async () => ({
          body: streamOf(new Uint8Array(500)),
          size: 500,
          httpMetadata: { contentType: 'video/mp4' },
          customMetadata: { sniffedType: 'video/mp4' }
        }))
      })
    );

    const body = await storage.read(KEY);

    expect(body?.rangeOffset).toBe(0);
    expect(body?.rangeLength).toBe(500);
  });
});

describe('R2VideoStorage.listExpired', () => {
  /**
   * Builds a listable object.
   *
   * @param key Object key.
   * @param ageMs How long ago it was uploaded.
   * @returns An `R2Object`-shaped entry.
   */
  function entry(key: string, ageMs: number) {
    return { key, uploaded: new Date(Date.now() - ageMs) };
  }

  it('returns only objects older than the cutoff', async () => {
    const storage = new R2VideoStorage(
      bucket({
        list: vi.fn(async () => ({
          objects: [
            entry(`${GENERATED_VIDEO_PREFIX}old`, 10 * 60_000),
            entry(`${GENERATED_VIDEO_PREFIX}new`, 60_000)
          ],
          truncated: false
        }))
      })
    );

    const expired = await storage.listExpired(new Date(Date.now() - 5 * 60_000), 100);

    expect(expired.map((object) => object.key)).toEqual([`${GENERATED_VIDEO_PREFIX}old`]);
  });

  it('scopes the listing to the generated-video prefix', async () => {
    // Pairs with the write guard: one proves nothing else is written there, this proves nothing
    // else is even looked at.
    const spy = bucket();
    const storage = new R2VideoStorage(spy);

    await storage.listExpired(new Date(), 10);

    const options = (spy.list as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as {
      prefix: string;
    };
    expect(options.prefix).toBe(GENERATED_VIDEO_PREFIX);
  });

  it('follows the cursor across pages', async () => {
    // R2 returns at most 1000 keys per call, so a bucket holding more would otherwise be silently
    // half-examined — and the objects missed would be the ones never collected.
    const pages = [
      {
        objects: [entry(`${GENERATED_VIDEO_PREFIX}a`, 10 * 60_000)],
        truncated: true,
        cursor: 'next'
      },
      { objects: [entry(`${GENERATED_VIDEO_PREFIX}b`, 20 * 60_000)], truncated: false }
    ];
    let call = 0;
    const storage = new R2VideoStorage(
      bucket({
        list: vi.fn(async () => pages[call++])
      })
    );

    const expired = await storage.listExpired(new Date(Date.now() - 60_000), 100);

    expect(expired).toHaveLength(2);
  });

  it('honours the caller’s budget', async () => {
    // A cron invocation has a finite wall-clock budget, so the caller's limit bounds the work
    // rather than the bucket's size. Falling behind is recoverable; a handler that always times out
    // is not.
    const storage = new R2VideoStorage(
      bucket({
        list: vi.fn(async () => ({
          objects: Array.from({ length: 50 }, (_unused, index) =>
            entry(`${GENERATED_VIDEO_PREFIX}${index}`, 10 * 60_000)
          ),
          truncated: true,
          cursor: 'more'
        }))
      })
    );

    const expired = await storage.listExpired(new Date(Date.now() - 60_000), 10);

    expect(expired).toHaveLength(10);
  });

  it('returns the oldest objects first', async () => {
    // A budgeted run should collect what has been waiting longest, not whatever R2 happened to list
    // first.
    const storage = new R2VideoStorage(
      bucket({
        list: vi.fn(async () => ({
          objects: [
            entry(`${GENERATED_VIDEO_PREFIX}newer`, 6 * 60_000),
            entry(`${GENERATED_VIDEO_PREFIX}oldest`, 30 * 60_000)
          ],
          truncated: false
        }))
      })
    );

    const expired = await storage.listExpired(new Date(Date.now() - 60_000), 10);

    expect(expired[0]?.key).toBe(`${GENERATED_VIDEO_PREFIX}oldest`);
  });
});
