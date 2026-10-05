/**
 * @file Tests for the provider-audio retrieval policy. This client is the one place in the Generate
 *   Music path that makes an outbound request to a host _a third party chose_, so every clause of
 *   its URL policy is asserted individually rather than as one "rejects a bad URL" case. Each
 *   clause refuses a specific way the returned URL could be used to reach somewhere it should not,
 *   and a policy that had quietly lost one of them would still pass a single combined test. The
 *   expiring-asset behaviour is tested here too, because this is where it is handled: a short-lived
 *   provider URL that has already expired answers with a `403`, `404`, or `410`, and the panel's
 *   contract is that such a response becomes a sanitised `502` carrying no provider text rather
 *   than a broken player.
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_MUSIC_BYTES } from '../../../src/shared/generate-music';
import { ProviderAudioClient } from '../../../src/worker/infrastructure/media/provider-audio-client';
import { mp3WithId3Bytes, rawPcmBytes, wavBytes } from '../support/audio-fixtures';
import { problemWithStatus } from '../support/problem-details';

/**
 * A signed provider URL of the shape MiniMax's catalogue examples return.
 */
const TRACK_URL =
  'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/music/prod/tts-1.mp3?token=signed';

/**
 * The approved host for {@link TRACK_URL}.
 */
const HOSTS = ['minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com'];

/**
 * Creates a byte-stream response.
 *
 * @param bytes Body to serve.
 * @param init Response status and headers.
 * @returns The response a fake fetch should resolve with.
 */
function response(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(new Blob([Uint8Array.from(bytes)]), init);
}

describe('retrieving an approved track', () => {
  it('fetches the track, sniffs its type, and reports its size and host', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(mp3WithId3Bytes(64))));
    const track = await new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS);

    expect(track.mediaType).toBe('audio/mpeg');
    expect(track.byteLength).toBe(74);
    expect(track.base64.length).toBeGreaterThan(0);
    // Reported so the panel's expiry disclosure can name the host it is talking about.
    expect(track.sourceHost).toBe('minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com');
  });

  // `redirect: 'manual'` rather than following, because a redirect could leave the approved host
  // list behind — which is the whole point of having one.
  it('never follows a redirect', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(mp3WithId3Bytes())));
    await new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS);

    expect(fetcher).toHaveBeenCalledWith(new URL(TRACK_URL), { redirect: 'manual' });
  });

  // Only WAV declares a duration cheaply and correctly in its header. An MP3's needs either a
  // constant-bitrate assumption that is wrong for real encoder output or a walk of every frame, so
  // it is reported as absent and the browser's own player measures it.
  it('reads a duration from a WAV header and reports none for an MP3', async () => {
    const wav = vi.fn(() => Promise.resolve(response(wavBytes(2))));
    const fromWav = await new ProviderAudioClient({ fetch: wav }).fetchTrack(TRACK_URL, HOSTS);
    expect(fromWav.mediaType).toBe('audio/wav');
    expect(fromWav.durationSeconds).toBeCloseTo(2, 2);

    const mp3 = vi.fn(() => Promise.resolve(response(mp3WithId3Bytes())));
    const fromMp3 = await new ProviderAudioClient({ fetch: mp3 }).fetchTrack(TRACK_URL, HOSTS);
    expect(fromMp3.durationSeconds).toBeUndefined();
  });
});

describe('the URL scheme and host policy', () => {
  // Each clause refuses a specific route to somewhere the Worker should not reach, so each is
  // asserted separately: a policy that had lost one of them would still pass a single combined case.
  it.each([
    // Plain HTTP would send the request in the clear.
    ['http://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/track.mp3', 'is not https'],
    // A host outside the allowlist is the allowlist's entire purpose.
    ['https://evil.example/track.mp3', 'is an unapproved host'],
    // A suffix match would accept this; an exact comparison does not.
    [
      'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com.evil.example/track.mp3',
      'merely looks like the approved host'
    ],
    // Embedded credentials would make this Worker authenticate to a host of a provider's choosing.
    [
      'https://user:pass@minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/track.mp3',
      'carries credentials'
    ],
    // An explicit port lets an allowlisted hostname address an unintended service on that host.
    [
      'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com:8443/track.mp3',
      'carries an explicit port'
    ],
    // A scheme with no network host at all, which would otherwise be a way to smuggle a payload
    // past the signature check.
    ['data:audio/mpeg;base64,SUQzAwA=', 'is a data URI rather than a provider URL'],
    ['file:///etc/passwd', 'is a file URL'],
    // Internal addresses, the classic server-side request forgery target. They are refused by the
    // host allowlist rather than by a separate address check, which is why the allowlist is exact.
    ['https://169.254.169.254/latest/meta-data/', 'is a link-local metadata address'],
    ['https://localhost/track.mp3', 'is the loopback host'],
    ['not a url at all', 'is unparseable']
  ])('refuses a URL that %s: %s', async (url) => {
    const fetcher = vi.fn();

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(url, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
    // Nothing was requested. The refusal has to happen before the fetch, or the Worker has already
    // made the request the policy exists to prevent.
    expect(fetcher).not.toHaveBeenCalled();
  });

  // A descriptor that declared no hosts must refuse every URL rather than accepting any, which is
  // the safe direction for an incompletely filled-in reviewed entry.
  it('refuses every URL when the descriptor approves no host', async () => {
    const fetcher = vi.fn();

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, [])
    ).rejects.toMatchObject(problemWithStatus(502));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a redirect response rather than following it to an unreviewed host', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response(new Uint8Array(), {
          status: 302,
          headers: { location: 'https://evil.example/track.mp3' }
        })
      )
    );

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
  });
});

describe('an expired or missing provider asset', () => {
  // The behaviour the panel's expiry disclosure is about. A signed URL that has lapsed answers with
  // one of these, and the result must be a sanitised `502` rather than a broken player or a
  // provider's own error text reaching the browser.
  it.each([403, 404, 410, 500, 503])(
    'reports an expired asset (%i) as a sanitised 502',
    async (status) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(response(new TextEncoder().encode('AccessDenied'), { status }))
      );

      await expect(
        new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
      ).rejects.toMatchObject(problemWithStatus(502));
    }
  );

  // The provider's own error text must not reach the visitor. A `403` body from an object store
  // routinely names buckets, keys, and request identifiers.
  it('does not carry the provider\u2019s error text into the response', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response(
          new TextEncoder().encode(
            '<Error><Code>AccessDenied</Code><BucketName>secret</BucketName></Error>'
          ),
          { status: 403 }
        )
      )
    );

    const error = (await new ProviderAudioClient({ fetch: fetcher })
      .fetchTrack(TRACK_URL, HOSTS)
      .catch((cause: unknown) => cause)) as { problemDetails: { detail: string } };

    expect(error.problemDetails.detail).not.toContain('AccessDenied');
    expect(error.problemDetails.detail).not.toContain('secret');
  });

  it('refuses an empty body', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(new Uint8Array())));

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
  });
});

describe('verifying what came back', () => {
  // The declared content type is never consulted: the payload reaches the page as a `data:` URI,
  // whose media type decides how the browser treats it, so the type comes from the bytes. This case
  // is a provider answering with an error document under a success status, which is a real behaviour
  // rather than a hypothetical one.
  it('refuses an HTML or JSON error document served with a 200 and an audio content type', async () => {
    for (const payload of ['<html><body>Gateway error</body></html>', '{"error":"quota"}']) {
      const fetcher = vi.fn(() =>
        Promise.resolve(
          response(new TextEncoder().encode(payload), {
            headers: { 'content-type': 'audio/mpeg' }
          })
        )
      );

      await expect(
        new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
      ).rejects.toMatchObject(problemWithStatus(502));
    }
  });

  // Raw headerless PCM is audio data that no browser will play, so it is refused rather than handed
  // to a player that would silently do nothing.
  it('refuses raw headerless audio data', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(rawPcmBytes(256))));

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
  });

  it('refuses a body whose declared length exceeds the cap', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response(mp3WithId3Bytes(), {
          headers: { 'content-length': String(MAX_MUSIC_BYTES + 1) }
        })
      )
    );

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
    // Refused from the header alone, without transferring the body.
    expect(fetcher).toHaveBeenCalledOnce();
  });

  // The cap has to be enforced during the read as well, because a declared length is the provider's
  // claim about its own body. A response that lies about its length, or omits the header entirely,
  // must still be bounded.
  it('refuses an oversized body that declared no length', async () => {
    const chunk = new Uint8Array(1_024 * 1_024);
    // A valid ID3 header at the front, so the refusal is about size rather than about the signature.
    chunk.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);

    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            /**
             * Emits more than the cap allows, a megabyte at a time.
             *
             * @param controller The stream's controller.
             * @returns Nothing; the stream is closed once enough has been enqueued to exceed the
             *   cap, though the reader should have aborted long before that.
             */
            start(controller): void {
              for (let sent = 0; sent <= MAX_MUSIC_BYTES; sent += chunk.length) {
                controller.enqueue(chunk);
              }
              controller.close();
            }
          })
        )
      )
    );

    await expect(
      new ProviderAudioClient({ fetch: fetcher }).fetchTrack(TRACK_URL, HOSTS)
    ).rejects.toMatchObject(problemWithStatus(502));
  });
});
