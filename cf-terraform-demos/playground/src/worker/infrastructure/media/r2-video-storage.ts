/**
 * @file R2-backed implementation of {@link VideoStoragePort}. Every method refuses a key outside
 *   {@link GENERATED_VIDEO_PREFIX}, and that check is here rather than only at the call sites
 *   because it is a containment guarantee rather than an argument check. The claim this demo makes
 *   is that it stores generated video and nothing else; a guard enforced at the single point where
 *   keys meet the bucket is what makes that claim true for every caller, including one added in a
 *   later phase by someone who has not read this file.
 */

import type { VideoMediaType } from '../../../shared/create-video';
import type {
  ExpirableVideoObject,
  StoredVideoBody,
  StoredVideoMetadata,
  VideoByteRange,
  VideoStoragePort
} from '../../application/ports/video-storage-port';
import { GENERATED_VIDEO_PREFIX } from '../../domain/media-job-identity';

/**
 * Custom-metadata field recording the sniffed media type.
 *
 * Stored alongside R2's own `httpMetadata.contentType` rather than instead of it. The HTTP metadata
 * is what a direct R2 read would report; this is the value _this demo_ established by inspecting
 * bytes, and keeping it separate means a future change to how objects are written cannot silently
 * turn a provider-declared type into one we appear to have verified.
 */
const SNIFFED_TYPE_FIELD = 'sniffedType';

/**
 * Rejects a key that does not belong to this demo's video prefix.
 *
 * @param key Key to check.
 * @returns Nothing when the key is acceptable.
 * @throws {Error} When the key falls outside {@link GENERATED_VIDEO_PREFIX}. Deliberately an
 *   `Error` rather than a problem-details response: a bad key is a programming fault in this
 *   Worker, not something a request could cause, so it should fail loudly rather than become a
 *   client error.
 */
function requireVideoKey(key: string): void {
  if (!key.startsWith(GENERATED_VIDEO_PREFIX) || key === GENERATED_VIDEO_PREFIX) {
    throw new Error(`Refusing to operate on "${key}": not a generated-video object key.`);
  }
}

/**
 * Stores generated video in an R2 bucket.
 */
export class R2VideoStorage implements VideoStoragePort {
  readonly #bucket: R2Bucket;

  /**
   * @param bucket The R2 bucket binding, supplied by the composition root.
   */
  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  /**
   * Stores a video by piping its stream into R2.
   *
   * @param key Derived object key.
   * @param body The bytes to store.
   * @param mediaType Media type established by sniffing.
   * @returns The stored object's metadata.
   * @throws {Error} When the key is outside the generated-video prefix, or when R2 reports the put
   *   as having failed a precondition — which cannot happen here, since no precondition is set, and
   *   therefore indicates something materially wrong rather than a routine conflict.
   */
  async store(
    key: string,
    body: ReadableStream<Uint8Array>,
    mediaType: VideoMediaType
  ): Promise<StoredVideoMetadata> {
    requireVideoKey(key);

    const stored = await this.#bucket.put(key, body, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { [SNIFFED_TYPE_FIELD]: mediaType }
    });

    if (stored === null) {
      throw new Error(`R2 declined to store the generated video for key "${key}".`);
    }

    return { mediaType, byteLength: stored.size };
  }

  /**
   * Reads a stored video, optionally a byte range.
   *
   * @param key Derived object key.
   * @param range Range to read, or `undefined` for the whole object.
   * @returns The body and metadata, or `undefined` when absent or when a conditional read returned
   *   no body.
   * @throws {Error} When the key is outside the generated-video prefix.
   */
  async read(key: string, range?: VideoByteRange): Promise<StoredVideoBody | undefined> {
    requireVideoKey(key);

    const object = await this.#bucket.get(
      key,
      range === undefined
        ? undefined
        : {
            range:
              range.length === undefined
                ? { offset: range.offset }
                : { offset: range.offset, length: range.length }
          }
    );

    if (object === null || !('body' in object) || object.body === null) {
      return undefined;
    }

    // `size` is the whole object's size regardless of any range, which is what a `Content-Range`
    // header needs for its total. The returned range's own length is read from `object.range` when
    // R2 reports one, since a request for more bytes than exist yields fewer than were asked for.
    const total = object.size;
    const resolved = object.range;
    const offset = resolved !== undefined && 'offset' in resolved ? (resolved.offset ?? 0) : 0;
    const length =
      resolved !== undefined && 'length' in resolved ? (resolved.length ?? total) : total - offset;

    return {
      body: object.body,
      mediaType: storedMediaType(object),
      byteLength: total,
      rangeOffset: offset,
      rangeLength: length
    };
  }

  /**
   * Reads the leading bytes of a stored video.
   *
   * @param key Derived object key.
   * @param length How many bytes to read.
   * @returns The leading bytes, or `undefined` when the object is absent.
   * @throws {Error} When the key is outside the generated-video prefix.
   */
  async readHead(key: string, length: number): Promise<Uint8Array | undefined> {
    requireVideoKey(key);

    const object = await this.#bucket.get(key, { range: { offset: 0, length } });
    if (object === null || !('body' in object) || object.body === null) {
      return undefined;
    }

    return new Uint8Array(await object.arrayBuffer());
  }

  /**
   * Deletes a stored video, tolerating its absence.
   *
   * @param key Derived object key.
   * @returns A promise fulfilled once the object is gone.
   * @throws {Error} When the key is outside the generated-video prefix.
   */
  async delete(key: string): Promise<void> {
    requireVideoKey(key);
    await this.#bucket.delete(key);
  }

  /**
   * Lists stored videos older than a cutoff.
   *
   * Pages through the prefix with R2's cursor rather than assuming one `list()` call sees
   * everything: R2 returns at most 1000 keys per call, and a bucket holding more would otherwise be
   * silently half-examined. The scan stops once `limit` collectable objects have been found, so the
   * caller's budget bounds the work rather than the bucket's size.
   *
   * @param olderThan Only objects stored strictly before this instant are returned.
   * @param limit Largest number of keys to return.
   * @returns The collectable objects, oldest first.
   */
  async listExpired(olderThan: Date, limit: number): Promise<ExpirableVideoObject[]> {
    const collected: ExpirableVideoObject[] = [];
    let cursor: string | undefined;

    while (collected.length < limit) {
      const page = await this.#bucket.list({
        prefix: GENERATED_VIDEO_PREFIX,
        ...(cursor === undefined ? {} : { cursor })
      });

      for (const object of page.objects) {
        if (object.uploaded.getTime() < olderThan.getTime()) {
          collected.push({ key: object.key, uploaded: object.uploaded });
          if (collected.length >= limit) {
            break;
          }
        }
      }

      if (!page.truncated) {
        break;
      }
      cursor = page.cursor;
    }

    // Oldest first, so a budgeted run collects the objects that have been waiting longest rather
    // than whichever ones R2 happened to list first.
    return collected.sort((left, right) => left.uploaded.getTime() - right.uploaded.getTime());
  }
}

/**
 * Reads back the media type this demo established when it stored an object.
 *
 * Prefers the custom metadata field over R2's HTTP metadata, because the custom field is the one
 * written from a sniffed value. Falls back to `video/mp4` only when neither is a type this panel
 * plays — the read path verifies the bytes independently before serving them, so this fallback
 * decides a header rather than whether an unverified object is served.
 *
 * @param object The R2 object.
 * @returns The recorded media type.
 */
function storedMediaType(object: R2Object): VideoMediaType {
  const custom = object.customMetadata?.[SNIFFED_TYPE_FIELD];
  if (custom === 'video/mp4' || custom === 'video/webm') {
    return custom;
  }
  const declared = object.httpMetadata?.contentType;
  if (declared === 'video/mp4' || declared === 'video/webm') {
    return declared;
  }
  return 'video/mp4';
}
