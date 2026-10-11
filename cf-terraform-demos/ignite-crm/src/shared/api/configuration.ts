/**
 * @file Browser-safe display configuration DTO (`GET /api/v1/configuration`). The SPA formats dates
 *   and money from this DTO instead of importing `src/configuration.ts`, so the server stays the
 *   single owner of installation settings and the browser bundle never gains a path to server-only
 *   configuration.
 */

import * as v from 'valibot';

/**
 * Intl `dateStyle` values accepted as the installation date format.
 */
export const DATE_FORMATS = ['short', 'medium', 'long'] as const;

/**
 * Schema for the display configuration.
 */
export const DisplayConfigurationSchema = v.strictObject({
  /**
   * ISO 3166-1 alpha-2 region, e.g. `GB`.
   */
  region: v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u, 'Region must be an ISO 3166-1 alpha-2 code.')),
  /**
   * BCP 47 locale used for text and dates, e.g. `en-GB`.
   */
  locale: v.pipe(v.string(), v.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, 'Invalid locale.')),
  /**
   * IANA time zone used to present instants, e.g. `Europe/London`.
   */
  timezone: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  /**
   * ISO 4217 installation currency, e.g. `GBP`.
   */
  currencyCode: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u, 'Currency must be an ISO 4217 code.')),
  /**
   * Currency symbol shown beside amounts, e.g. `£`.
   */
  currencySymbol: v.pipe(v.string(), v.minLength(1), v.maxLength(4)),
  /**
   * Intl `dateStyle` used for calendar dates.
   */
  dateFormat: v.picklist(DATE_FORMATS),
  /**
   * BCP 47 locale used for number grouping and decimal marks.
   */
  numberFormat: v.pipe(v.string(), v.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)),
  /**
   * First day of the week: 0 = Sunday, 1 = Monday.
   */
  weekStartsOn: v.picklist([0, 1])
});

/**
 * The display configuration.
 */
export type DisplayConfiguration = v.InferOutput<typeof DisplayConfigurationSchema>;
