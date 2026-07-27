import {
  contentTooLarge,
  internalServerError,
  notFound,
} from "@adrianhall/cloudflare-toolkit/errors";
import { MAX_MEDIA_SIZE_BYTES } from "./validation";

/** Result of an R2 read, retaining the headers needed for a streamed HTTP response. */
export interface StoredMedia {
  /** Streamed R2 object body, when a conditional request did not fail. */
  body: ReadableStream | null;
  /** HTTP headers copied from R2's persisted metadata. */
  headers: Headers;
  /** Whether the request selected a byte range. */
  partial: boolean;
  /** Whether R2 rejected a conditional request. */
  preconditionFailed: boolean;
}

/**
 * Build an opaque, owner-scoped R2 key without placing a raw email address in object storage.
 *
 * @param owner Verified Access email.
 * @param id Immutable media UUID.
 * @returns R2 key namespaced by a SHA-256 owner digest.
 */
export async function createMediaKey(
  owner: string,
  id: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(owner),
  );
  const ownerHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `media/${ownerHash}/${id}`;
}

/**
 * Stream an upload to R2 while enforcing a byte cap even without Content-Length.
 *
 * @param bucket R2 bucket binding.
 * @param key Destination object key.
 * @param body Request stream.
 * @param contentType Validated MIME type to persist as R2 HTTP metadata.
 * @returns Exact byte size returned by R2 after storage.
 * @throws {ProblemDetailsError} When the stream exceeds the configured limit.
 */
export async function putMedia(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream,
  contentType: string,
): Promise<number> {
  let byteCount = 0;
  const cappedStream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        byteCount += chunk.byteLength;
        if (byteCount > MAX_MEDIA_SIZE_BYTES) {
          controller.error(
            contentTooLarge({ detail: "Media must not exceed 50 MiB." }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const object = await bucket.put(key, cappedStream, {
    httpMetadata: { contentType },
  });
  if (object === null) {
    throw internalServerError({ detail: "Media could not be stored." });
  }
  return object.size;
}

/**
 * Read an object from R2 and translate its metadata into safe HTTP response values.
 *
 * @param bucket R2 bucket binding.
 * @param key Private object key from D1.
 * @param request Incoming HTTP request with range and conditional headers.
 * @param title Validated media title used for the response filename.
 * @returns Streamed object result with response headers.
 * @throws {ProblemDetailsError} When the object no longer exists.
 */
export async function getMedia(
  bucket: R2Bucket,
  key: string,
  request: Request,
  title: string,
): Promise<StoredMedia> {
  const object = await bucket.get(key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (object === null) {
    throw notFound({ detail: "Media not found." });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Disposition", contentDisposition(title, request));

  if (!("body" in object)) {
    return { body: null, headers, partial: false, preconditionFailed: true };
  }

  if (object.range !== undefined) {
    const { offset, length } = resolvedRange(object.range, object.size);
    headers.set("Content-Length", String(length));
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    return {
      body: object.body,
      headers,
      partial: true,
      preconditionFailed: false,
    };
  }

  headers.set("Content-Length", String(object.size));
  return {
    body: object.body,
    headers,
    partial: false,
    preconditionFailed: false,
  };
}

/**
 * Resolve R2's requested range shape into the concrete offset and length required by HTTP.
 *
 * @param range R2 range returned for the object read.
 * @param size Full object size in bytes.
 * @returns Concrete byte offset and returned length.
 */
function resolvedRange(
  range: R2Range,
  size: number,
): { offset: number; length: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: range.length ?? size - offset };
}

/**
 * Delete an R2 object after ownership has been verified through its D1 metadata.
 *
 * @param bucket R2 bucket binding.
 * @param key Private object key from D1.
 * @returns Promise resolved after R2 accepts the deletion.
 */
export async function deleteMedia(
  bucket: R2Bucket,
  key: string,
): Promise<void> {
  await bucket.delete(key);
}

/**
 * Construct an ASCII-safe RFC 5987 disposition filename from a media title.
 *
 * @param title Validated media title.
 * @param request Request whose `download` query controls attachment behavior.
 * @returns Content-Disposition header value.
 */
function contentDisposition(title: string, request: Request): string {
  const disposition =
    new URL(request.url).searchParams.get("download") === "1"
      ? "attachment"
      : "inline";
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(title)}`;
}
