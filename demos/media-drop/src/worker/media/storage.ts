import {
  internalServerError,
  notFound,
} from "@adrianhall/cloudflare-toolkit/errors";

/** Result of an R2 read, retaining the headers needed for a streamed HTTP response. */
export interface StoredMedia {
  /** Streamed R2 object body, when a conditional request did not fail. */
  body: ReadableStream | null;
  /** HTTP headers copied from R2's persisted metadata. */
  headers: Headers;
  /** Whether the request selected a byte range. */
  partial: boolean;
  /** Conditional response status when R2 omitted the object body, otherwise `null`. */
  conditionalStatus: 304 | 412 | null;
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
 * Stream a validated upload to R2 while retaining a fixed stream length for the R2 binding.
 *
 * @param bucket R2 bucket binding.
 * @param key Destination object key.
 * @param body Request stream.
 * @param contentType Validated MIME type to persist as R2 HTTP metadata.
 * @param contentLength Validated byte length used to retain stream length for R2.
 * @returns Exact byte size returned by R2 after storage.
 * @throws {ProblemDetailsError} When R2 cannot store the stream.
 */
export async function putMedia(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream,
  contentType: string,
  contentLength: number,
): Promise<number> {
  const stream = new FixedLengthStream(contentLength);
  const write = body.pipeTo(stream.writable);
  const store = bucket.put(key, stream.readable, {
    httpMetadata: { contentType },
  });
  const [object] = await Promise.all([store, write]);
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
    return {
      body: null,
      headers,
      partial: false,
      conditionalStatus: conditionalStatus(request),
    };
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader !== null) {
    const range = resolveRequestedRange(rangeHeader, object.size);
    if (range === null) {
      throw internalServerError({
        detail: "Media range could not be resolved.",
      });
    }
    const { offset, length } = range;
    headers.set("Content-Length", String(length));
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    return {
      body: object.body,
      headers,
      partial: true,
      conditionalStatus: null,
    };
  }

  headers.set("Content-Length", String(object.size));
  return {
    body: object.body,
    headers,
    partial: false,
    conditionalStatus: null,
  };
}

/**
 * Map failed R2 conditions to the HTTP response status expected by a browser.
 *
 * @param request Original request whose conditional headers were passed to R2.
 * @returns `304` for cache revalidation and `412` for every other failed precondition.
 */
function conditionalStatus(request: Request): 304 | 412 {
  return request.headers.has("If-None-Match") ||
    request.headers.has("If-Modified-Since")
    ? 304
    : 412;
}

/**
 * Resolve one HTTP byte-range header into the concrete offset and length returned by R2.
 *
 * @param header Browser `Range` request header.
 * @param size Full object size in bytes.
 * @returns Concrete byte offset and returned length, or `null` for an invalid range.
 */
export function resolveRequestedRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header ?? "");
  if (match === null || (match[1] === "" && match[2] === "")) {
    return null;
  }
  const [, start, end] = match;
  if (start === "") {
    const length = Math.min(Number(end), size);
    return length > 0 ? { offset: size - length, length } : null;
  }

  const offset = Number(start);
  const finalByte = end === "" ? size - 1 : Math.min(Number(end), size - 1);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(finalByte) ||
    offset > finalByte
  ) {
    return null;
  }
  return { offset, length: finalByte - offset + 1 };
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
