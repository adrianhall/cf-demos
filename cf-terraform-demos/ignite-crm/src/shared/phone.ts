import type { CountryCode } from 'libphonenumber-js';
/**
 * @file Shared phone-number normalization and display. New writes must be valid numbers and are
 *   stored in E.164; reads preserve historical free-text values until a safe, reviewed backfill.
 *   `libphonenumber-js/min` (one entry point everywhere) supplies the validation metadata in
 *   browser and Worker alike, so the same input cannot be accepted by one tier and rejected by the
 *   other.
 */
import { parsePhoneNumberWithError } from 'libphonenumber-js/min';

/**
 * Parse and normalize a newly entered phone number.
 *
 * @param input Raw phone text, or `null`/blank to clear it.
 * @param region Installation's ISO 3166-1 alpha-2 region, used for numbers without a `+` prefix.
 * @returns An E.164 number, or `null` when blank.
 * @throws {RangeError} When the number is not a valid phone number or the region is unknown.
 */
export function normalizePhone(input: string | null, region: string): string | null {
  if (input === null || input.trim() === '') return null;
  try {
    const parsed = parsePhoneNumberWithError(input.trim(), {
      defaultCountry: region as CountryCode,
      extract: false
    });
    if (parsed.isValid() && parsed.ext === undefined) return parsed.number;
  } catch {
    // The same safe error is shown for malformed numbers and unknown regions; do not echo input.
  }
  throw new RangeError('Enter a valid phone number, including an area code.');
}

/**
 * Display a stored number in the installation's national format when local, or international format
 * otherwise. Legacy free-text values are shown unchanged, not silently reinterpreted.
 *
 * @param stored E.164 number or a legacy free-text value.
 * @param region Installation region.
 * @returns Readable phone text, or `null` when absent.
 */
export function displayPhone(stored: string | null, region: string): string | null {
  if (stored === null) return null;
  if (!/^\+[1-9]\d{1,14}$/u.test(stored)) return stored;
  try {
    const parsed = parsePhoneNumberWithError(stored);
    return parsed.country === region ? parsed.formatNational() : parsed.formatInternational();
  } catch {
    return stored;
  }
}
