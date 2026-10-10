import {
  contentTooLarge,
  notFound,
  unprocessableContent,
  unsupportedMediaType,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { UploadInput } from "./types";

/** Largest object accepted by this short-media demonstration. */
export const MAX_MEDIA_SIZE_BYTES = 100 * 1024 * 1024;

const MAX_TITLE_LENGTH = 280;
const mediaIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedContentTypes = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

/**
 * Validate upload headers before the request stream is passed to R2.
 *
 * @param request Upload request carrying `X-Media-Title`, `Content-Type`, and optionally
 * `Content-Length`.
 * @returns Normalized upload metadata.
 * @throws {ProblemDetailsError} When the title, media type, or declared size is invalid.
 */
export function validateUploadRequest(request: Request): UploadInput {
  if (request.body === null) {
    throw unprocessableContent({ detail: "A media request body is required." });
  }

  const title = request.headers.get("X-Media-Title")?.trim();
  if (
    title === undefined ||
    title.length === 0 ||
    title.length > MAX_TITLE_LENGTH
  ) {
    throw unprocessableContent({
      detail: "X-Media-Title must be between 1 and 280 characters.",
    });
  }

  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === undefined || !allowedContentTypes.has(contentType)) {
    throw unsupportedMediaType({
      detail: "Content-Type must be an allowed image, audio, or video type.",
    });
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader === null) {
    throw unprocessableContent({
      detail: "Content-Length is required for media uploads.",
    });
  }

  if (!/^\d+$/u.test(contentLengthHeader)) {
    throw unprocessableContent({
      detail: "Content-Length must be a non-negative integer.",
    });
  }

  const contentLength = Number(contentLengthHeader);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > MAX_MEDIA_SIZE_BYTES
  ) {
    throw contentTooLarge({ detail: "Media must not exceed 100 MiB." });
  }
  return { title, contentType, contentLength, body: request.body };
}

/**
 * Validate an opaque media UUID without revealing other owners' records.
 *
 * @param id Candidate path parameter.
 * @returns The validated UUID.
 * @throws {ProblemDetailsError} When the ID is malformed.
 */
export function validateMediaId(id: string): string {
  if (!mediaIdPattern.test(id)) {
    throw notFound({ detail: "Media not found." });
  }
  return id;
}
