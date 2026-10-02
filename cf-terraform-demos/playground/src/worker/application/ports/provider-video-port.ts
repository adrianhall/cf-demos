/**
 * @file Application port for retrieving a provider-hosted generated video and placing it in
 *   storage. The image equivalent of this port returns bytes, because an image is small enough to
 *   hold. This one returns only metadata and deliberately never yields the bytes to its caller: the
 *   adapter pipes the provider's response straight into storage. Handing a use case a 100 MB buffer
 *   would be handing it the isolate's entire memory budget, and a use case that cannot touch the
 *   bytes cannot accidentally buffer them.
 */

import type { StoredVideoMetadata } from './video-storage-port';

/**
 * Retrieves generated video from an approved provider origin and stores it.
 */
export interface ProviderVideoPort {
  /**
   * Fetches one provider result under strict URL, redirect, and size policy and stores it.
   *
   * The two operations are one method rather than two because they must not be separable: a fetch
   * whose bytes were returned to the caller would have to be buffered to be passed, which is the
   * thing this design exists to prevent.
   *
   * @param reference Provider-returned HTTPS URL.
   * @param allowedHosts Exact HTTPS hosts reviewed for the selected model.
   * @param key Derived storage key to store the video under.
   * @returns The stored video's media type and size.
   * @throws {ProblemDetailsError} With `502` when the URL is unsafe, the fetch fails or redirects,
   *   the body exceeds the byte cap, or the bytes are not a video container this panel plays.
   */
  fetchAndStore(
    reference: string,
    allowedHosts: readonly string[],
    key: string
  ): Promise<StoredVideoMetadata>;
}
