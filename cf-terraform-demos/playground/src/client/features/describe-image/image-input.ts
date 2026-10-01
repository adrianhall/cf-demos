/**
 * @file Pure helpers for turning a chosen file into something the panel can send and show. Plain
 *   functions over plain data: no Vue, no fetch, no component state. Every check here is a
 *   courtesy, not a control. The server re-derives the format from the bytes and re-measures the
 *   picture, because a browser-side check protects nobody — it only spares a visitor a round trip
 *   and a confusing error. Saying so plainly matters, because client-side validation that _looks_
 *   authoritative is how people end up trusting it.
 */

import { MAX_INPUT_IMAGE_BYTES } from '../../../describe-image';

/**
 * Media types the file picker will offer and the panel will preview.
 *
 * Matches the server's allowlist. SVG is absent for the same reason it is absent server-side: it is
 * a scripting context rather than a picture, and previewing one in the page would execute it.
 */
export const ACCEPTED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * The `accept` attribute for the file input.
 *
 * Only a filter on the picker's dialogue — a visitor can still choose any file, and the server is
 * what actually decides.
 */
export const UPLOAD_ACCEPT_ATTRIBUTE = ACCEPTED_UPLOAD_TYPES.join(',');

/**
 * A picture the panel is ready to send.
 */
export interface PreparedImage {
  /**
   * The bytes, base64-encoded, as the request carries them.
   */
  base64: string;
  /**
   * A `data:` URI for the on-screen preview.
   *
   * Built from the type the _browser_ reported, which is safe here only because that type was first
   * checked against {@link ACCEPTED_UPLOAD_TYPES}. The server independently sniffs the bytes and
   * may disagree; when it does, its answer is the one the panel reports afterwards.
   */
  previewUri: string;
  /**
   * Size of the decoded picture in bytes.
   */
  byteLength: number;
  /**
   * The file's own name, shown so a visitor can tell two uploads apart.
   *
   * Displayed only. It is never sent to the server and never used to decide anything: a file name
   * is attacker-controlled text, and the panel's other identifiers are the run and the bytes.
   */
  fileName: string;
}

/**
 * Why a chosen file was refused before it was ever sent.
 */
export type ImageRejectionReason = 'unsupported-type' | 'too-large' | 'unreadable' | 'empty';

/**
 * The outcome of preparing a chosen file.
 */
export type PrepareImageOutcome =
  | { ok: true; image: PreparedImage }
  | { ok: false; reason: ImageRejectionReason; message: string };

/**
 * Human-facing explanation for each refusal.
 *
 * Each one says what to do next rather than only what went wrong, because "unsupported type" on its
 * own leaves a visitor guessing which types _are_ supported.
 */
const REJECTION_MESSAGES: Readonly<Record<ImageRejectionReason, string>> = {
  'unsupported-type': 'That file is not a picture this panel accepts. Use a PNG, JPEG, or WebP.',
  'too-large': `That picture is larger than the ${Math.round(
    MAX_INPUT_IMAGE_BYTES / (1_024 * 1_024)
  )} MB limit. Scale it down and try again.`,
  'unreadable': 'That file could not be read. Try choosing it again.',
  'empty': 'That file is empty.'
};

/**
 * Encodes bytes as base64.
 *
 * Built in 8 KiB chunks rather than one spread call, for the same reason the Worker's encoder is:
 * `String.fromCharCode(...bytes)` on a multi-megabyte picture exceeds the argument limit and throws
 * a `RangeError`, turning a large but valid file into an unexplained failure.
 *
 * @param bytes Data to encode.
 * @returns The base64 representation.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 8_192;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/**
 * Reports whether the browser's declared type is one the panel will preview.
 *
 * @param type The `type` the `File` reported.
 * @returns `true` when the type is in the allowlist.
 */
export function isAcceptedUploadType(type: string): boolean {
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(type);
}

/**
 * Prepares a chosen file for sending and previewing.
 *
 * @param file The file a visitor picked, dropped, or pasted.
 * @returns The prepared picture, or a refusal carrying a reason and a message to show; see
 *   {@link PrepareImageOutcome}. Refusals are returned rather than thrown because every one of them
 *   is an ordinary thing a visitor can do, not an exceptional condition.
 */
export async function prepareImage(file: File): Promise<PrepareImageOutcome> {
  if (!isAcceptedUploadType(file.type)) {
    return reject('unsupported-type');
  }

  if (file.size === 0) {
    return reject('empty');
  }

  // Checked before reading, so an oversized file is refused without pulling it into memory first.
  if (file.size > MAX_INPUT_IMAGE_BYTES) {
    return reject('too-large');
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // A file that vanished or became unreadable between selection and reading — removable media,
    // or a file replaced underneath the picker.
    return reject('unreadable');
  }

  if (bytes.length === 0) {
    return reject('empty');
  }

  const base64 = encodeBase64(bytes);

  return {
    ok: true,
    image: {
      base64,
      previewUri: `data:${file.type};base64,${base64}`,
      byteLength: bytes.length,
      fileName: file.name
    }
  };
}

/**
 * Builds a refusal outcome.
 *
 * @param reason Why the file was refused.
 * @returns The refusal, with its matching message.
 */
function reject(reason: ImageRejectionReason): PrepareImageOutcome {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

/**
 * Extracts the first usable image from a paste event's clipboard.
 *
 * Pasting is the fastest way to get a screenshot into the panel, and a screenshot is the most
 * likely thing someone wants described, so it is supported alongside the file picker.
 *
 * @param items Clipboard items from a paste event.
 * @returns The first file whose declared type is accepted, or `undefined` when the clipboard held
 *   no picture — pasted text, for instance, which should simply do nothing here.
 */
export function imageFromClipboard(items: DataTransferItemList | undefined): File | undefined {
  if (items === undefined) {
    return undefined;
  }

  for (const item of items) {
    if (item.kind !== 'file' || !isAcceptedUploadType(item.type)) {
      continue;
    }

    const file = item.getAsFile();
    if (file !== null) {
      return file;
    }
  }

  return undefined;
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
