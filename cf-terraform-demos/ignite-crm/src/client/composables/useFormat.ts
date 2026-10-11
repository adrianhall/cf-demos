/**
 * @file Locale-aware formatting driven by the server's display configuration DTO.
 */

import type { DisplayConfiguration } from '../../shared/api/configuration.ts';
import { useSession } from './useSession.ts';

/**
 * Fallback used before the configuration has loaded.
 */
const FALLBACK: DisplayConfiguration = {
  region: 'GB',
  locale: 'en-GB',
  timezone: 'Europe/London',
  currencyCode: 'GBP',
  currencySymbol: '£',
  dateFormat: 'medium',
  numberFormat: 'en-GB',
  weekStartsOn: 1
};

/**
 * Formatters.
 */
export interface Formatters {
  /**
   * Format a UTC instant as a date and time in the installation time zone.
   *
   * @param iso UTC ISO timestamp.
   * @returns Display text.
   */
  dateTime(iso: string): string;
  /**
   * Format a `YYYY-MM-DD` calendar date without shifting it across time zones.
   *
   * @param date Calendar date.
   * @returns Display text.
   */
  date(date: string): string;
  /**
   * Format integer minor units in the installation currency.
   *
   * @param minor Amount in minor units (pence).
   * @returns Display text.
   */
  money(minor: number): string;
  /**
   * Format an integer count.
   *
   * @param value The count.
   * @returns Display text.
   */
  count(value: number): string;
}

/**
 * Build formatters for a configuration.
 *
 * @param config Display configuration.
 * @returns The formatters.
 */
export function createFormatters(config: DisplayConfiguration): Formatters {
  return {
    dateTime: (iso) =>
      new Intl.DateTimeFormat(config.locale, {
        dateStyle: config.dateFormat,
        timeStyle: 'short',
        timeZone: config.timezone
      }).format(new Date(iso)),
    date: (date) =>
      new Intl.DateTimeFormat(config.locale, {
        dateStyle: config.dateFormat,
        timeZone: 'UTC'
      }).format(new Date(`${date}T00:00:00.000Z`)),
    money: (minor) =>
      new Intl.NumberFormat(config.numberFormat, {
        style: 'currency',
        currency: config.currencyCode
      }).format(minor / 100),
    count: (value) => new Intl.NumberFormat(config.numberFormat).format(value)
  };
}

/**
 * Formatters for the current installation.
 *
 * @returns Formatters reading the loaded configuration at call time.
 */
export function useFormat(): Formatters {
  const { configuration } = useSession();
  const current = (): Formatters => createFormatters(configuration.value ?? FALLBACK);
  return {
    dateTime: (iso) => current().dateTime(iso),
    date: (date) => current().date(date),
    money: (minor) => current().money(minor),
    count: (value) => current().count(value)
  };
}
