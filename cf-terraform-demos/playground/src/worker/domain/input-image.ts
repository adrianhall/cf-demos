/**
 * @file Shared byte-authoritative validation for panels that accept raster image input.
 */
import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_IMAGE_EDGE_PIXELS,
  MAX_INPUT_IMAGE_BYTES,
  MIN_IMAGE_EDGE_PIXELS,
  type VerifiedImageFacts
} from '../../shared/describe-image';
import { decodeBase64, readImageDimensions, sniffImageMediaType } from './image-bytes';

/**
 * A validated source or mask image.
 */
export interface ValidatedInputImage {
  /**
   * Decoded, verified image bytes.
   */
  bytes: Uint8Array;
  /**
   * Content-derived image facts.
   */
  facts: VerifiedImageFacts;
}

/**
 * Validates a base64 raster image without trusting browser-provided metadata.
 *
 * @param value Untrusted base64 field.
 * @param field Field name for actionable validation messages.
 * @param purpose Human-facing action for a missing image.
 * @returns Signature-verified bytes and header-derived facts.
 * @throws {ProblemDetailsError} When input is missing, malformed, too large, unsupported, damaged,
 *   or outside the allowed dimensions.
 */
export function validateInputImage(
  value: unknown,
  field: string,
  purpose: string
): ValidatedInputImage {
  if (typeof value !== 'string') {
    throw badRequest({ detail: `Request body must contain a "${field}" string.` });
  }
  if (value === '') {
    throw badRequest({ detail: `Choose a picture to ${purpose}.` });
  }
  if (value.length > Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4 + 4) {
    throw tooLarge();
  }

  const bytes = decodeBase64(value);
  if (bytes === undefined || bytes.length === 0) {
    throw badRequest({
      detail: 'That picture could not be read. Upload it again, or try a different file.'
    });
  }
  if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
    throw tooLarge();
  }

  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    throw badRequest({
      detail: 'That file is not a picture this panel accepts. Use a PNG, JPEG, or WebP image.'
    });
  }
  const dimensions = readImageDimensions(bytes, mediaType);
  if (dimensions === undefined) {
    throw badRequest({
      detail: 'That picture’s dimensions could not be read, so it may be damaged.'
    });
  }
  if (Math.max(dimensions.width, dimensions.height) > MAX_IMAGE_EDGE_PIXELS) {
    throw badRequest({
      detail: `That picture is ${dimensions.width}×${dimensions.height} pixels, and this panel accepts up to ${MAX_IMAGE_EDGE_PIXELS} on its longest edge. Scale it down and try again.`
    });
  }
  if (Math.min(dimensions.width, dimensions.height) < MIN_IMAGE_EDGE_PIXELS) {
    throw badRequest({
      detail: `That picture is ${dimensions.width}×${dimensions.height} pixels, which is too small for this task.`
    });
  }
  return { bytes, facts: { mediaType, byteLength: bytes.length, ...dimensions } };
}

/**
 * Builds the shared oversized-input error.
 *
 * @returns A problem-details error explaining the byte limit.
 * @throws {ProblemDetailsError} Always.
 */
function tooLarge(): never {
  throw badRequest({
    detail: `That picture is larger than ${Math.round(MAX_INPUT_IMAGE_BYTES / (1_024 * 1_024))} MB. Scale it down and try again.`
  });
}
