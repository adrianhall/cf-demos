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
  // Build each `Intl` formatter once per configuration; constructing them is far costlier than
  // formatting, and list views format hundreds of values per render.
  const dateTime = new Intl.DateTimeFormat(config.locale, {
    dateStyle: config.dateFormat,
    timeStyle: 'short',
    timeZone: config.timezone
  });
  const date = new Intl.DateTimeFormat(config.locale, {
    dateStyle: config.dateFormat,
    timeZone: 'UTC'
  });
  const money = new Intl.NumberFormat(config.numberFormat, {
    style: 'currency',
    currency: config.currencyCode
  });
  const count = new Intl.NumberFormat(config.numberFormat);
  return {
    dateTime: (iso) => dateTime.format(new Date(iso)),
    date: (value) => date.format(new Date(`${value}T00:00:00.000Z`)),
    money: (minor) => money.format(minor / 100),
    count: (value) => count.format(value)
  };
}

/**
 * Formatters per loaded configuration object. A weak map, so a replaced configuration (a session
 * reload) builds fresh formatters and the old ones can be collected.
 */
const cache = new WeakMap<DisplayConfiguration, Formatters>();

/**
 * Formatters for a configuration, built once and shared.
 *
 * @param config The configuration.
 * @returns Cached formatters.
 */
function formattersFor(config: DisplayConfiguration): Formatters {
  let formatters = cache.get(config);
  if (formatters === undefined) {
    formatters = createFormatters(config);
    cache.set(config, formatters);
  }
  return formatters;
}

/**
 * Formatters for the current installation.
 *
 * @returns Formatters reading the loaded configuration at call time.
 */
export function useFormat(): Formatters {
  const { configuration } = useSession();
  // Read the configuration at call time (it may load after the component mounts), but reuse the
  // formatters built for it.
  const current = (): Formatters => formattersFor(configuration.value ?? FALLBACK);
  return {
    dateTime: (iso) => current().dateTime(iso),
    date: (date) => current().date(date),
    money: (minor) => current().money(minor),
    count: (value) => current().count(value)
  };
}
