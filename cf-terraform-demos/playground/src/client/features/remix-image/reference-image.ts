/**
 * Browser-side preparation for models with a smaller reference-image ceiling.
 */
import { encodeBase64, type PreparedImage } from '../describe-image/image-input';

/**
 * Downscales a source for a model while retaining the original preview for comparison.
 *
 * This is a courtesy, not a security boundary: the Worker independently reads the resulting header
 * and enforces the descriptor limit. The operation runs only for the Cloudflare-hosted FLUX model,
 * whose current contract limits each reference to 512×512.
 *
 * @param source Original prepared source image.
 * @param maxEdge Longest edge accepted by the selected model, or undefined for no resize.
 * @returns Base64 bytes suitable for the selected model.
 * @throws {Error} When the browser cannot decode or encode the image.
 */
export async function referenceImageBase64(
  source: PreparedImage,
  maxEdge: number | undefined
): Promise<string> {
  if (maxEdge === undefined) {
    return source.base64;
  }

  const image = await loadImage(source.previewUri);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1) {
    return source.base64;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('This browser cannot resize the reference image.');
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await canvasBlob(canvas, 'image/png');
  return encodeBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Loads an image and rejects corrupt browser-decodable content.
 */
function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('The reference image could not be decoded for resizing.'));
    image.src = uri;
  });
}

/**
 * Encodes a canvas without using a giant synchronous data URI.
 */
function canvasBlob(canvas: HTMLCanvasElement, mediaType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('The resized reference image could not be encoded.'));
      } else {
        resolve(blob);
      }
    }, mediaType);
  });
}
