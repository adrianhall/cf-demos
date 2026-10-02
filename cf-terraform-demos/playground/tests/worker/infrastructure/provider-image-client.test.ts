import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../../src/images';
import { ProviderImageClient } from '../../../src/worker/infrastructure/media/provider-image-client';
import { pngBytes } from '../support/image-fixtures';
import { problemWithStatus } from '../support/problem-details';

const RESULT_URL = 'https://delivery.bfl.ai/results/run/sample.png?token=signed';

/**
 * Creates a byte-stream response.
 */
function response(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(new Blob([Uint8Array.from(bytes)]), init);
}

describe('ProviderImageClient', () => {
  it('retrieves and sniffs a reviewed provider URL without following redirects', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(pngBytes())));
    const image = await new ProviderImageClient({ fetch: fetcher }).fetchImage(RESULT_URL, [
      'delivery.bfl.ai'
    ]);
    expect(image).toMatchObject({ mediaType: 'image/png', byteLength: 24 });
    expect(fetcher).toHaveBeenCalledWith(new URL(RESULT_URL), { redirect: 'manual' });
  });

  it.each([
    'http://delivery.bfl.ai/result.png',
    'https://evil.example/result.png',
    'https://delivery.bfl.ai.evil.example/result.png',
    'https://user:pass@delivery.bfl.ai/result.png',
    'https://delivery.bfl.ai:8443/result.png'
  ])('rejects unsafe provider location %s', async (url) => {
    const fetcher = vi.fn();
    await expect(
      new ProviderImageClient({ fetch: fetcher }).fetchImage(url, ['delivery.bfl.ai'])
    ).rejects.toMatchObject(problemWithStatus(502));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalises an inline provider image without a network request', async () => {
    const fetcher = vi.fn();
    const inline = `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes()))}`;
    const image = await new ProviderImageClient({ fetch: fetcher }).fetchImage(inline, []);
    expect(image.mediaType).toBe('image/png');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses redirects rather than following them to an unreviewed host', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(new Uint8Array(), { status: 302 })));
    await expect(
      new ProviderImageClient({ fetch: fetcher }).fetchImage(RESULT_URL, ['delivery.bfl.ai'])
    ).rejects.toMatchObject(problemWithStatus(502));
  });

  it('refuses oversized and non-image responses', async () => {
    const oversized = vi.fn(() =>
      Promise.resolve(
        response(new Uint8Array(), { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })
      )
    );
    await expect(
      new ProviderImageClient({ fetch: oversized }).fetchImage(RESULT_URL, ['delivery.bfl.ai'])
    ).rejects.toMatchObject(problemWithStatus(502));

    const text = vi.fn(() => Promise.resolve(response(new TextEncoder().encode('not an image'))));
    await expect(
      new ProviderImageClient({ fetch: text }).fetchImage(RESULT_URL, ['delivery.bfl.ai'])
    ).rejects.toMatchObject(problemWithStatus(502));
  });
});
