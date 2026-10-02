/**
 * @file Application port for retrieving a provider-hosted generated image before its signed URL
 *   expires. Keeping fetch in infrastructure lets the use case receive verified bytes without
 *   gaining arbitrary network access.
 */
import type { GeneratedImage } from '../../../shared/images';

/**
 * Retrieves and verifies generated media from an approved provider origin.
 */
export interface GeneratedMediaPort {
  /**
   * Fetches one provider result under strict URL, redirect, size, and signature policy.
   *
   * @param reference Provider-returned HTTPS URL or image data URI.
   * @param allowedHosts Exact HTTPS hosts reviewed for the selected model. Empty when only an
   *   inline data URI is accepted.
   * @returns Transient, byte-sniffed image data.
   * @throws {ProblemDetailsError} When the URL is unsafe, the fetch fails, redirects, exceeds the
   *   byte cap, or is not a supported raster image.
   */
  fetchImage(reference: string, allowedHosts: readonly string[]): Promise<GeneratedImage>;
}
