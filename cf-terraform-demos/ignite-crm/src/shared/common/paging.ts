/**
 * @file Cursor pagination shared by every list operation. Cursors are opaque to callers: a client
 *   only ever echoes back the `nextCursor` it was given. The Data Worker encodes the sort key of
 *   the last row so the next page is a stable keyset seek rather than an `OFFSET`, which stays
 *   correct while rows are inserted between page loads.
 */

import * as v from 'valibot';

/**
 * Largest page any list operation returns (specification §14: RPC pages max 100).
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Page size used when a caller does not ask for one.
 */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Schema for an opaque cursor: base64url text of bounded length.
 */
export const CursorSchema = v.pipe(
  v.string(),
  v.maxLength(512, 'Cursor is too long.'),
  v.regex(/^[A-Za-z0-9_-]+$/u, 'Cursor is malformed.')
);

/**
 * Schema for a page request.
 */
export const PageRequestSchema = v.strictObject({
  /**
   * Maximum number of items to return, 1–100.
   */
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_PAGE_SIZE)),
    DEFAULT_PAGE_SIZE
  ),
  /**
   * Cursor returned by the previous page, absent for the first page.
   */
  cursor: v.optional(CursorSchema)
});

/**
 * A validated page request with its default limit applied.
 */
export type PageRequest = v.InferOutput<typeof PageRequestSchema>;

/**
 * Build the schema for one page of items.
 *
 * @param item Schema each item must satisfy.
 * @returns A schema for `{ items, nextCursor }`.
 */
export function pageSchema<TItem extends v.GenericSchema>(item: TItem) {
  return v.strictObject({
    /**
     * The items on this page, in the operation's documented order.
     */
    items: v.array(item),
    /**
     * Cursor for the following page, or `null` when this is the last page.
     */
    nextCursor: v.nullable(CursorSchema)
  });
}

/**
 * One page of items.
 */
export interface Page<TItem> {
  /**
   * The items on this page.
   */
  readonly items: readonly TItem[];
  /**
   * Cursor for the following page, or `null` on the last page.
   */
  readonly nextCursor: string | null;
}
