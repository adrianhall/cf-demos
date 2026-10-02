/**
 * @file Application port for storing and serving generated video. Phases 2–7 needed no storage port
 *   at all, because their media was transient by construction: an image was base64-encoded into a
 *   JSON response and forgotten. This panel cannot work that way. A `<video>` element seeks with
 *   `Range` requests, and a base64 string in a JSON body cannot answer one, so the result has to
 *   live somewhere addressable. The port is deliberately narrow — store, read a range, delete, and
 *   collect — so the application tier gains the ability to keep a video and nothing else. In
 *   particular it exposes no `list` of arbitrary prefixes and no way to name a key directly: keys
 *   are derived (see `domain/media-job-identity.ts`), so a use case cannot reach an object it did
 *   not derive the name of.
 */

import type { VideoMediaType } from '../../../shared/create-video';

/**
 * A byte range a browser asked for.
 *
 * Mirrors the subset of `R2Range` this demo uses. Expressed in the port rather than passing R2's
 * own option type through, so the application tier does not depend on a storage product's
 * vocabulary.
 */
export interface VideoByteRange {
  /**
   * First byte to return, inclusive.
   */
  offset: number;
  /**
   * How many bytes to return. Absent means "to the end of the object".
   */
  length?: number;
}

/**
 * A stored video's metadata, without its bytes.
 */
export interface StoredVideoMetadata {
  /**
   * Media type established by inspecting the bytes at store time.
   */
  mediaType: VideoMediaType;
  /**
   * Total size of the object in bytes.
   */
  byteLength: number;
}

/**
 * A stored video's bytes, together with what is needed to answer a ranged request.
 */
export interface StoredVideoBody extends StoredVideoMetadata {
  /**
   * The bytes, as a stream. A stream rather than a buffer so a multi-megabyte video is relayed
   * without ever occupying the isolate's 128 MB budget.
   */
  body: ReadableStream<Uint8Array>;
  /**
   * First byte this body starts at, for building a `Content-Range` header.
   */
  rangeOffset: number;
  /**
   * How many bytes this body carries.
   */
  rangeLength: number;
}

/**
 * One object the reaper may collect.
 */
export interface ExpirableVideoObject {
  /**
   * The object's key.
   */
  key: string;
  /**
   * When it was stored.
   */
  uploaded: Date;
}

/**
 * Where generated video is kept.
 */
export interface VideoStoragePort {
  /**
   * Stores a video from a stream.
   *
   * Takes a stream rather than bytes on purpose: a provider's response is piped straight through to
   * storage, so a 100 MB video never exists as a buffer in the isolate.
   *
   * @param key Object key, which must have been produced by `videoObjectKey()`.
   * @param body The bytes to store.
   * @param mediaType Media type already established by sniffing the leading bytes, recorded so the
   *   read path does not have to re-derive it before it can set a response header.
   * @returns The stored object's metadata.
   * @throws {Error} When the key is outside the generated-video prefix, which would mean a caller
   *   had bypassed key derivation.
   */
  store(
    key: string,
    body: ReadableStream<Uint8Array>,
    mediaType: VideoMediaType
  ): Promise<StoredVideoMetadata>;

  /**
   * Reads a stored video, optionally a byte range of it.
   *
   * @param key Object key.
   * @param range The range to read, or `undefined` for the whole object.
   * @returns The body and its metadata, or `undefined` when no such object exists.
   */
  read(key: string, range?: VideoByteRange): Promise<StoredVideoBody | undefined>;

  /**
   * Reads the first bytes of a stored video, for independent verification before serving it.
   *
   * Separate from {@link VideoStoragePort.read} because the verification path needs a small buffer
   * it can inspect synchronously, while the serving path needs a stream it must not consume.
   *
   * @param key Object key.
   * @param length How many leading bytes to read.
   * @returns The leading bytes, or `undefined` when no such object exists.
   */
  readHead(key: string, length: number): Promise<Uint8Array | undefined>;

  /**
   * Deletes a stored video.
   *
   * Idempotent: deleting an absent object is not an error, because cancellation races a job that
   * may never have stored anything.
   *
   * @param key Object key.
   * @returns A promise fulfilled once the object is gone.
   * @throws {Error} When the key is outside the generated-video prefix.
   */
  delete(key: string): Promise<void>;

  /**
   * Lists stored videos older than a cutoff, for the scheduled reaper.
   *
   * Bounded by `limit` rather than returning everything, because a cron invocation has a finite
   * budget and a reaper that tries to drain an unbounded backlog in one firing fails exactly when
   * there is most to clean up.
   *
   * @param olderThan Only objects stored strictly before this instant are returned.
   * @param limit Largest number of keys to return.
   * @returns The collectable objects, oldest first.
   */
  listExpired(olderThan: Date, limit: number): Promise<ExpirableVideoObject[]>;
}
