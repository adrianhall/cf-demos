/**
 * @file Reusable scalar field rules. These are wire-level rules — shape and size — that every
 *   transport enforces identically. Domain modules in `src/data-worker/domain` may reuse them, but
 *   business invariants (for example "a contact needs a name or a company") belong in the domain,
 *   not here.
 */

import * as v from 'valibot';

/**
 * Schema for an `Idempotency-Key` header value: 8–128 printable, header-safe characters.
 */
export const IdempotencyKeySchema = v.pipe(
  v.string(),
  v.minLength(8, 'Idempotency-Key must be at least 8 characters.'),
  v.maxLength(128, 'Idempotency-Key must be at most 128 characters.'),
  v.regex(/^[A-Za-z0-9._:-]+$/u, 'Idempotency-Key contains unsupported characters.')
);

/**
 * Schema for an optimistic-concurrency version (1 or greater).
 */
export const VersionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * Build a schema for a required, trimmed, single-line text field.
 *
 * @param label Field name used in messages.
 * @param max Maximum length after trimming.
 * @returns The schema.
 */
export function requiredText(label: string, max: number) {
  return v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(`${label} is required.`),
    v.maxLength(max, `${label} must be at most ${max} characters.`)
  );
}

/**
 * Build a schema for an optional, trimmed text field where blank means absent.
 *
 * Blank strings become `null`, so a form that submits an empty input does not store `''` and later
 * render an empty label.
 *
 * @param label Field name used in messages.
 * @param max Maximum length after trimming.
 * @returns The schema.
 */
export function optionalText(label: string, max: number) {
  return v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.trim(),
        v.maxLength(max, `${label} must be at most ${max} characters.`),
        v.transform((value) => (value === '' ? null : value))
      )
    ),
    null
  );
}

/**
 * Schema for an optional e-mail address (normalised to lowercase).
 */
export const OptionalEmailSchema = v.optional(
  v.nullable(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => (value === '' ? null : value.toLowerCase())),
      v.nullable(v.pipe(v.string(), v.maxLength(254), v.email('Must be a valid e-mail address.')))
    )
  ),
  null
);

/**
 * Schema for an optional `https:` URL. Other protocols are rejected so a stored link can be
 * rendered as an anchor without a `javascript:` risk.
 */
export const OptionalHttpsUrlSchema = v.optional(
  v.nullable(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => (value === '' ? null : value)),
      v.nullable(
        v.pipe(
          v.string(),
          v.maxLength(2048),
          v.url('Must be a valid URL.'),
          v.startsWith('https://', 'Must be an https:// URL.')
        )
      )
    )
  ),
  null
);

/**
 * Schema for a bounded free-text search term.
 */
export const SearchTermSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Search term must not be empty.'),
  v.maxLength(100, 'Search term must be at most 100 characters.')
);
