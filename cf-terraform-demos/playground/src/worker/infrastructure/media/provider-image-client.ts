/**
 * @file Safe normalisation of inline or short-lived provider generated images.
 */
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_IMAGE_BYTES, type GeneratedImage } from '../../../images';
import type { GeneratedMediaPort } from '../../application/ports/generated-media-port';
import { decodeBase64, encodeBase64, sniffImageMediaType } from '../../domain/image-bytes';

/**
 * Fetch-compatible seam used by tests.
 */
export type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Dependencies for {@link ProviderImageClient}.
 */
export interface ProviderImageClientOptions {
  /**
   * Injectable fetch implementation.
   */
  fetch?: MediaFetch;
}

/**
 * Normalises generated images under a descriptor-owned origin policy.
 */
export class ProviderImageClient implements GeneratedMediaPort {
  readonly #fetch: MediaFetch;

  /**
   * @param options Optional test fetch seam.
   */
  constructor(options: ProviderImageClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * @param reference Provider-returned HTTPS URL or image data URI.
   * @param allowedHosts Exact HTTPS hosts reviewed for this model.
   * @returns Verified transient image bytes.
   * @throws {ProblemDetailsError} With `502` for an unsafe reference, failed response, oversized
   *   body, or unsupported content.
   */
  async fetchImage(reference: string, allowedHosts: readonly string[]): Promise<GeneratedImage> {
    if (reference.startsWith('data:')) {
      return normaliseDataUri(reference);
    }

    const url = validatedProviderUrl(reference, allowedHosts);
    const response = await this.#fetch(url, { redirect: 'manual' });
    if (!response.ok || response.status >= 300) {
      throw mediaFailure('The generated image could not be retrieved from the model provider.');
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_IMAGE_BYTES) {
      throw mediaFailure('The generated image was larger than this demo will relay.');
    }
    if (response.body === null) {
      throw mediaFailure('The model provider returned an empty image response.');
    }
    return normaliseBytes(await readBounded(response.body));
  }
}

/**
 * Decodes a base64 data URI while ignoring its caller-controlled declared media type.
 */
function normaliseDataUri(reference: string): GeneratedImage {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reference);
  if (match?.[1] === undefined) {
    throw mediaFailure('The model provider returned an invalid inline image.');
  }
  if (match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw mediaFailure('The generated image was larger than this demo will relay.');
  }
  const bytes = decodeBase64(match[1]);
  if (bytes === undefined) {
    throw mediaFailure('The model provider returned an invalid inline image.');
  }
  return normaliseBytes(bytes);
}

/**
 * Validates scheme, credentials, port, and exact descriptor-owned host.
 */
function validatedProviderUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw mediaFailure('The model provider returned an invalid image URL.');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || !allowedHosts.includes(url.hostname)
  ) {
    throw mediaFailure('The model provider returned an image URL from an unapproved origin.');
  }
  return url;
}

/**
 * Signature-checks image bytes and produces the shared transport shape.
 */
function normaliseBytes(bytes: Uint8Array): GeneratedImage {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw mediaFailure('The generated image had an invalid size.');
  }
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    throw mediaFailure('The model provider returned data this demo will not render as an image.');
  }
  return { base64: encodeBase64(bytes), mediaType, byteLength: bytes.length };
}

/**
 * Reads a response stream while enforcing the generated-image cap during buffering.
 */
async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        throw mediaFailure('The generated image was larger than this demo will relay.');
      }
      chunks.push(value);
    }
  } finally {
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
 */
function mediaFailure(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The remixed image could not be retrieved',
    detail
  });
}
