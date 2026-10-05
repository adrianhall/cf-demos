/**
 * @file Safe retrieval of a provider-hosted generated track. Both reviewed music models answer with
 *   a URL on their own CDN rather than with bytes, which creates a problem this demo has met before
 *   and solves the same way: the URL is fetched **server-side**, from an allowlisted host, and the
 *   bytes are identified by signature before anything is handed to a browser. Rendering the
 *   provider's URL directly in the page would be simpler and worse in three separate ways. It would
 *   leak the visitor's IP address and `Referer` to a third-party CDN on every play. It would make
 *   the panel's primary result depend on an external host's retention, so reopening a result later
 *   would show a broken player. And it would let a provider decide how the browser treats its
 *   response, because the media type would come from that host's `Content-Type` header rather than
 *   from the bytes. Unlike Create Video, nothing is stored. The whole track is buffered — bounded —
 *   and returned in the response, because a two-minute track is a few megabytes, an `<audio>`
 *   element can seek freely within a payload the page already holds, and storing it would add a
 *   retention surface this demo would then have to promise something about. The read is bounded
 *   _during_ buffering rather than after it, so a provider answering with something far larger than
 *   its own contract implies cannot exhaust the isolate before the check runs.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_MUSIC_BYTES, type GeneratedTrack } from '../../../shared/generate-music';
import type { GeneratedAudioPort } from '../../application/ports/generated-audio-port';
import { readAudioDurationSeconds, sniffAudioMediaType } from '../../domain/audio-bytes';
import { encodeBase64 } from '../../domain/image-bytes';

/**
 * Fetch-compatible seam used by tests.
 */
export type AudioFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Dependencies for {@link ProviderAudioClient}.
 */
export interface ProviderAudioClientOptions {
  /**
   * Injectable fetch implementation, so the suite exercises the real policy offline.
   */
  fetch?: AudioFetch;
}

/**
 * Retrieves generated audio under a descriptor-owned origin policy.
 */
export class ProviderAudioClient implements GeneratedAudioPort {
  readonly #fetch: AudioFetch;

  /**
   * Creates the client.
   *
   * @param options Optional test fetch seam; see {@link ProviderAudioClientOptions}.
   */
  constructor(options: ProviderAudioClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Fetches and verifies one provider-hosted track.
   *
   * @param reference Provider-returned HTTPS URL.
   * @param allowedHosts Exact HTTPS hosts reviewed for this model.
   * @returns The verified track and the host it came from.
   * @throws {ProblemDetailsError} With `502` for an unsafe reference, a failed or redirecting
   *   response, an empty body, a body exceeding {@link MAX_MUSIC_BYTES}, or bytes that are not
   *   audio this panel will play.
   */
  async fetchTrack(reference: string, allowedHosts: readonly string[]): Promise<GeneratedTrack> {
    const url = validatedProviderUrl(reference, allowedHosts);

    // `redirect: 'manual'` rather than following: a redirect could leave the approved host list
    // behind, which is the whole point of having one.
    const response = await this.#fetch(url, { redirect: 'manual' });
    if (!response.ok || response.status >= 300) {
      throw audioFailure('The generated track could not be retrieved from the model provider.');
    }

    // Checked before reading where the provider declared a length, so an obviously oversized
    // response is refused without transferring it. The stream read below enforces the same cap
    // regardless, because a declared length is the provider's claim about its own body.
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_MUSIC_BYTES) {
      throw audioFailure('The generated track was larger than this demo will relay.');
    }
    if (response.body === null) {
      throw audioFailure('The model provider returned an empty audio response.');
    }

    const bytes = await readBounded(response.body);
    if (bytes.length === 0) {
      throw audioFailure('The model provider returned an empty audio response.');
    }

    // The declared content type is deliberately never consulted. The payload reaches the page as a
    // `data:` URI, whose media type decides how the browser treats it, so the type comes from the
    // bytes. This is also what catches a provider answering with an HTML error page or a JSON fault
    // document under a success status — a real behaviour rather than a hypothetical one.
    const mediaType = sniffAudioMediaType(bytes);
    if (mediaType === undefined) {
      throw audioFailure(
        'The model provider returned data this demo will not play as audio. Only MP3 and WAV are '
          + 'accepted.'
      );
    }

    const durationSeconds = readAudioDurationSeconds(bytes, mediaType);

    return {
      base64: encodeBase64(bytes),
      mediaType,
      byteLength: bytes.length,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      // Reported so the panel's expiry disclosure can name the host it is talking about. It is the
      // allowlisted host, which is already published through the catalogue.
      sourceHost: url.hostname
    };
  }
}

/**
 * Validates scheme, credentials, port, and exact descriptor-owned host.
 *
 * Every clause refuses a specific way a URL could be used to reach somewhere it should not. `http:`
 * would send the request in the clear; embedded credentials would make this Worker authenticate to
 * a host of a provider's choosing; an explicit port would let an allowlisted hostname address an
 * unintended service on that host; and the host check is the allowlist itself.
 *
 * @param rawUrl The provider's returned URL.
 * @param allowedHosts Exact hosts the descriptor approves.
 * @returns The parsed URL.
 * @throws {ProblemDetailsError} With `502` when the URL is unparseable, is not HTTPS, carries
 *   credentials or an explicit port, or names a host outside the approved list.
 */
function validatedProviderUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw audioFailure('The model provider returned an invalid audio URL.');
  }

  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || !allowedHosts.includes(url.hostname)
  ) {
    throw audioFailure('The model provider returned an audio URL from an unapproved origin.');
  }

  return url;
}

/**
 * Reads a response stream, refusing to buffer more than the cap allows.
 *
 * The limit is enforced during the read rather than after it. Buffering an unbounded provider
 * response and only then measuring it would let a misbehaving upstream exhaust the isolate's memory
 * before the check ran.
 *
 * @param stream The provider's response body.
 * @returns The concatenated bytes.
 * @throws {ProblemDetailsError} With `502` once the accumulated size exceeds
 *   {@link MAX_MUSIC_BYTES}.
 */
async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.length;
      if (total > MAX_MUSIC_BYTES) {
        throw audioFailure('The generated track was larger than this demo will relay.');
      }

      chunks.push(value);
    }
  } finally {
    // Runs on the size-limit throw as well as on normal completion, so an abandoned read releases
    // the upstream stream instead of leaving it open for the isolate's lifetime.
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

/**
 * Builds the sanitised provider-media failure.
 *
 * @param detail Visitor-facing explanation, carrying no provider error text.
 * @returns A `502` problem-details error.
 */
function audioFailure(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The generated track could not be retrieved',
    detail
  });
}
