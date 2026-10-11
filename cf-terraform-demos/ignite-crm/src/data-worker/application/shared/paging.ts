/**
 * @file Keyset paging shared by every Data Worker module: the validated page request a repository
 *   receives, and the opaque cursor codec. It lives in `application/shared` (not in one module)
 *   because CRM, sales, projects, notes, and team listings all page the same way, and a module must
 *   not import another module's service just to reuse a helper.
 */

import { serviceError } from '../../../shared/common/errors.ts';

/**
 * A page request after validation.
 */
export interface ListCriteria {
  /**
   * Lower-cased search term, if any.
   */
  readonly q: string | null;
  /**
   * Page size.
   */
  readonly limit: number;
  /**
   * Decoded keyset position.
   */
  readonly after: { readonly key: string; readonly id: string } | null;
}

/**
 * Encode a keyset position as an opaque cursor.
 *
 * @param key Sort key of the last row.
 * @param id Identifier of the last row.
 * @returns A base64url cursor.
 */
export function encodeCursor(key: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([key, id]));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Decode a cursor produced by {@link encodeCursor}.
 *
 * @param cursor The cursor.
 * @param requestId Request identifier for the error.
 * @returns The keyset position.
 * @throws {Error} A `VALIDATION_FAILED` service error when the cursor was not produced here.
 */
export function decodeCursor(cursor: string, requestId: string): { key: string; id: string } {
  try {
    const binary = atob(cursor.replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
    ) {
      return { key: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error below.
  }
  throw serviceError('VALIDATION_FAILED', 'The cursor is invalid.', {
    requestId,
    fields: { cursor: 'The cursor is invalid.' }
  });
}
