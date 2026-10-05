/**
 * @file Application port for retrieving a provider-hosted generated track before its short-lived
 *   URL expires. Keeping the fetch in infrastructure lets the use case receive verified bytes
 *   without gaining arbitrary network access — which matters here more than it reads, because the
 *   URL being fetched was chosen by a third party. The host allowlist is what separates "fetch the
 *   track this model just produced" from "fetch whatever a provider names", and it lives beside the
 *   fetch rather than in the use case so there is one place to audit. Deliberately a separate port
 *   from {@link GeneratedMediaPort}, which retrieves images. The two look similar and differ in
 *   every detail that matters: a different byte cap, a different signature allowlist, and a
 *   different answer to "what is this payload". Collapsing them into one port taking a media kind
 *   would mean one implementation deciding which rules to apply from a flag, which is exactly the
 *   shape that lets an audio response be validated as an image.
 */

import type { GeneratedTrack } from '../../../shared/generate-music';

/**
 * Retrieves and verifies a generated audio track from an approved provider origin.
 */
export interface GeneratedAudioPort {
  /**
   * Fetches one provider-hosted track under strict URL, redirect, size, and signature policy.
   *
   * @param reference Provider-returned HTTPS URL, taken from the model's own response envelope and
   *   therefore untrusted.
   * @param allowedHosts Exact HTTPS hosts reviewed for the selected model. An empty list refuses
   *   every URL, which is the safe direction for a descriptor that declared none.
   * @returns The verified track: its bytes, the media type established from its signature, its
   *   size, its duration where the container declares one cheaply, and the host it came from.
   * @throws {ProblemDetailsError} With `502` when the URL is unparseable, is not HTTPS, carries
   *   credentials or an explicit port, names a host outside the allowlist, redirects, fails,
   *   exceeds the byte cap, or returns bytes that are not audio this panel will play.
   */
  fetchTrack(reference: string, allowedHosts: readonly string[]): Promise<GeneratedTrack>;
}
