/**
 * @file Safe retrieval of a provider-hosted generated video, straight into storage. The hard part
 *   is doing three things at once: establishing the media type from the _leading_ bytes, enforcing
 *   a byte cap across the _whole_ body, and never holding more than a chunk of it. A simpler
 *   implementation would buffer the response, sniff it, then store it — and would put a
 *   multi-megabyte video in a 128 MB isolate for no reason. Instead the body is piped through a
 *   `TransformStream` that inspects the first chunks as they pass, counts every byte, and aborts
 *   the stream the moment the cap is exceeded. The type is resolved from a promise that settles as
 *   soon as enough leading bytes have been seen, so storage can begin before the provider has
 *   finished sending. If the bytes turn out not to be a video this panel plays, the stream is
 *   cancelled and nothing is written.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_VIDEO_BYTES } from '../../../shared/create-video';
import type { ProviderVideoPort } from '../../application/ports/provider-video-port';
import type {
  StoredVideoMetadata,
  VideoStoragePort
} from '../../application/ports/video-storage-port';
import { sniffVideoMediaType, VIDEO_SNIFF_BYTES } from '../../domain/video-bytes';

/**
 * Fetch-compatible seam used by tests.
 */
export type VideoFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Dependencies for {@link ProviderVideoClient}.
 */
export interface ProviderVideoClientOptions {
  /**
   * Where the retrieved video is written.
   */
  storage: VideoStoragePort;
  /**
   * Injectable fetch implementation.
   */
  fetch?: VideoFetch;
}

/**
 * Retrieves generated video under a descriptor-owned origin policy and stores it.
 */
export class ProviderVideoClient implements ProviderVideoPort {
  readonly #storage: VideoStoragePort;
  readonly #fetch: VideoFetch;

  /**
   * @param options Storage port and optional test fetch seam.
   */
  constructor(options: ProviderVideoClientOptions) {
    this.#storage = options.storage;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Fetches and stores one provider video.
   *
   * @param reference Provider-returned HTTPS URL.
   * @param allowedHosts Exact HTTPS hosts reviewed for this model.
   * @param key Derived storage key.
   * @returns The stored video's media type and size.
   * @throws {ProblemDetailsError} With `502` for an unsafe reference, a failed or redirecting
   *   response, an empty body, a body exceeding {@link MAX_VIDEO_BYTES}, or bytes that are not a
   *   playable video container.
   */
  async fetchAndStore(
    reference: string,
    allowedHosts: readonly string[],
    key: string
  ): Promise<StoredVideoMetadata> {
    const url = validatedProviderUrl(reference, allowedHosts);

    // `redirect: 'manual'` rather than following: a redirect could leave the approved host list
    // behind, which is the whole point of having one.
    const response = await this.#fetch(url, { redirect: 'manual' });
    if (!response.ok || response.status >= 300) {
      throw videoFailure('The generated video could not be retrieved from the model provider.');
    }

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_VIDEO_BYTES) {
      throw videoFailure('The generated video was larger than this demo will store.');
    }
    if (response.body === null) {
      throw videoFailure('The model provider returned an empty video response.');
    }

    // The head is read first, and only the head: enough bytes to identify the container, which is
    // at most a kilobyte. Sniffing has to happen before the write opens, because storage records
    // the content type at `put` time and a type guessed now and corrected later would leave the
    // object permanently mislabelled. Buffering a kilobyte to avoid that is a trade worth making;
    // buffering the whole video would not be.
    const { head, rest } = await readHead(response.body, VIDEO_SNIFF_BYTES);

    const mediaType = sniffVideoMediaType(head);
    if (mediaType === undefined) {
      // Nothing has been written yet, so refusing here leaves no object behind. This is also the
      // case that catches a provider answering with an HTML error page or a JSON fault document
      // under a success status, which is a real behaviour rather than a hypothetical one.
      await rest.cancel().catch(() => undefined);
      throw videoFailure('The model provider returned data this demo will not play as a video.');
    }

    const stored = await this.#storage.store(
      key,
      // The head is re-emitted ahead of the remaining stream, so the stored object is the whole
      // response rather than the response minus its first kilobyte. Everything after this point
      // streams: the cap is enforced chunk by chunk and no further buffering occurs.
      boundedStream(head, rest),
      mediaType
    );

    return { mediaType, byteLength: stored.byteLength };
  }
}

/**
 * Reads up to `length` leading bytes without consuming the rest of the stream.
 *
 * @param body The provider's response body.
 * @param length How many leading bytes to buffer.
 * @returns The buffered head and the still-unread remainder.
 */
async function readHead(
  body: ReadableStream<Uint8Array>,
  length: number
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < length) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  return { head: concat(chunks, total), rest: body };
}

/**
 * Re-emits a buffered head followed by the remaining stream, enforcing the byte cap throughout.
 *
 * The cap is applied here rather than only against `Content-Length`, because a declared length is
 * the provider's claim about its own body and a body may exceed it. Erroring the stream aborts the
 * R2 write in progress, so an oversized response does not leave a partial object behind.
 *
 * @param head Bytes already read.
 * @param rest The unread remainder.
 * @returns One stream carrying the whole response, bounded by {@link MAX_VIDEO_BYTES}.
 */
function boundedStream(
  head: Uint8Array,
  rest: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  let total = head.length;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (head.length > 0) {
        controller.enqueue(head);
      }
      if (total > MAX_VIDEO_BYTES) {
        controller.error(videoFailure('The generated video was larger than this demo will store.'));
        return;
      }

      const reader = rest.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          total += value.length;
          if (total > MAX_VIDEO_BYTES) {
            controller.error(
              videoFailure('The generated video was larger than this demo will store.')
            );
            return;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (cause) {
        controller.error(cause);
      } finally {
        reader.releaseLock();
      }
    }
  });
}

/**
 * Joins buffered leading chunks into one buffer.
 *
 * @param chunks Buffered chunks.
 * @param length Combined length.
 * @returns One contiguous buffer.
 */
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Validates scheme, credentials, port, and exact descriptor-owned host.
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
    throw videoFailure('The model provider returned an invalid video URL.');
  }

  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || !allowedHosts.includes(url.hostname)
  ) {
    throw videoFailure('The model provider returned a video URL from an unapproved origin.');
  }

  return url;
}

/**
 * Builds the sanitised provider-media failure.
 *
 * @param detail Visitor-facing explanation, carrying no provider error text.
 * @returns A `502` problem-details error.
 */
function videoFailure(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The generated video could not be retrieved',
    detail
  });
}
