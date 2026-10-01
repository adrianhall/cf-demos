/**
 * @file Pure gallery state for the Create Image panel. Plain functions over plain data: no Vue, no
 *   fetch, no DOM. The rules worth testing in isolation are how a result becomes a renderable
 *   `data:` URI, how alt text is derived, and how the gallery is bounded.
 */

import {
  IMAGE_FILE_EXTENSIONS,
  isRenderableImageMediaType,
  type AppliedImageControls,
  type GeneratedImage
} from '../../../images';

/**
 * Most results kept in the gallery at once.
 *
 * Each result holds a multi-megabyte base64 string in memory, so an unbounded gallery would grow a
 * long session's tab until it was evicted. Six is enough to compare a handful of attempts, which is
 * what the gallery is for.
 */
export const MAX_GALLERY_RESULTS = 6;

/**
 * One generated image as the panel displays it.
 */
export interface GalleryEntry {
  /**
   * Run that produced the image, used as the list key and to correlate run details.
   */
  runId: string;
  /**
   * The verified image bytes and media type.
   */
  image: GeneratedImage;
  /**
   * Settings the image was generated with, so a visitor comparing two results can see what differs.
   */
  applied: AppliedImageControls;
  /**
   * Human-facing model name, resolved from the catalogue at the time of generation.
   */
  modelName: string;
}

/**
 * Builds the `data:` URI used to render a generated image.
 *
 * The media type comes from the server's byte-level sniff, and is re-checked here against the same
 * allowlist. That re-check is not redundant: this function is what hands a media type to the
 * browser's `data:` URI parser, and a `data:` URI's type decides how the payload is treated. Having
 * the check at the point of use means a future code path that obtained an image some other way
 * cannot skip it.
 *
 * @param image The generated image.
 * @returns A `data:` URI safe to use as an `img` source.
 * @throws {Error} When the media type is not one of the renderable raster formats. Thrown rather
 *   than silently returning an empty string, because a blank image would look like a rendering bug
 *   instead of a refusal.
 */
export function toDataUri(image: GeneratedImage): string {
  // Read into a `string` before the guard. Inside the negative branch the narrowed type of
  // `image.mediaType` is `never`, which cannot be interpolated into the error message that has to
  // report it.
  const declared: string = image.mediaType;

  if (!isRenderableImageMediaType(declared)) {
    throw new Error(`Refusing to render unexpected media type "${declared}".`);
  }

  return `data:${declared};base64,${image.base64}`;
}

/**
 * Builds the download file name for a result.
 *
 * The extension follows the sniffed media type, so a saved file's name always agrees with its
 * bytes. The prompt is deliberately excluded: a file name built from user text is a needless
 * injection surface, and a long prompt makes an unusable name.
 *
 * @param entry The gallery entry being downloaded.
 * @returns A stable, safe file name.
 */
export function downloadFileName(entry: GalleryEntry): string {
  const extension = IMAGE_FILE_EXTENSIONS[entry.image.mediaType];
  return `playground-${entry.runId}.${extension}`;
}

/**
 * Builds the download control's accessible label.
 *
 * Names the format explicitly, because "Download" alone tells a screen-reader user nothing about
 * what they are about to save, and the format is not otherwise conveyed anywhere.
 *
 * @param entry The gallery entry being downloaded.
 * @returns A label such as `"Download this image as PNG"`.
 */
export function downloadLabel(entry: GalleryEntry): string {
  const extension = IMAGE_FILE_EXTENSIONS[entry.image.mediaType];
  return `Download this image as ${extension.toUpperCase()}`;
}

/**
 * Builds the alt text for a generated image.
 *
 * The prompt is the only honest description available: nothing here has actually looked at the
 * picture, so the alt text says what was _asked for_ and labels it as such rather than asserting
 * what the image contains. Phrasing it as "generated from the prompt" avoids claiming knowledge the
 * panel does not have, which matters because a diffusion model frequently does not produce what was
 * requested.
 *
 * Describe Image, in the next phase, is the panel that can actually describe a picture — and the
 * handoff between the two is the honest way to get a real description.
 *
 * @param entry The gallery entry.
 * @returns Alt text naming the prompt it was generated from.
 */
export function imageAltText(entry: GalleryEntry): string {
  return `Image generated from the prompt: ${entry.applied.prompt}`;
}

/**
 * Adds a result to the gallery, newest first, within the size bound.
 *
 * Newest first because the thing a visitor just asked for is the thing they want to look at. The
 * oldest entry is dropped once the bound is reached, which also releases its base64 payload.
 *
 * @param existing Current gallery entries, newest first.
 * @param entry Result to add.
 * @returns The new gallery, at most {@link MAX_GALLERY_RESULTS} long.
 */
export function addToGallery(
  existing: readonly GalleryEntry[],
  entry: GalleryEntry
): GalleryEntry[] {
  return [entry, ...existing].slice(0, MAX_GALLERY_RESULTS);
}

/**
 * Formats a byte count for display.
 *
 * @param bytes Size to describe.
 * @returns A short string such as `"1.4 MB"` or `"860 KB"`.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_024 * 1_024) {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
}
