/**
 * @file Brand palette and accessible foreground/background pairs in both Vuetify themes.
 */

import { describe, expect, it } from 'vitest';
import { createAppVuetify } from '../../src/client/vuetify.ts';

/**
 * WCAG relative luminance for a six-digit hex colour.
 *
 * @param hex The colour.
 * @returns Relative luminance.
 */
function luminance(color: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/**
 * WCAG contrast ratio of two opaque colours.
 *
 * @param foreground Text colour.
 * @param background Fill colour.
 * @returns The contrast ratio.
 */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * Require a hex string from Vuetify's broad colour-value type before measuring contrast.
 *
 * @param value Theme colour.
 * @returns The hex string.
 */
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error('Expected a six-digit hex theme colour.');
  }
  return value;
}

describe('Ignite brand themes', () => {
  const themes = createAppVuetify().theme.themes.value;

  it.each(['light', 'dark'])('%s retains the requested brand anchors and AA text pairs', (mode) => {
    const colors = themes[mode]?.colors;
    expect(colors).toBeDefined();
    if (colors === undefined) return;
    expect(colors.primary).toBe('#FC7C1E');
    expect(colors.secondary).toBe('#5A73F4');
    for (const name of [
      'primary',
      'secondary',
      'primary-container',
      'secondary-container',
      'background',
      'surface'
    ]) {
      const fill = colors[name];
      const foreground = colors[`on-${name}`];
      expect(fill, `${mode} ${name} fill`).toBeDefined();
      expect(foreground, `${mode} ${name} foreground`).toBeDefined();
      expect(
        contrast(hex(foreground), hex(fill)),
        `${mode} ${name} contrast`
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['primary-strong', 'secondary-strong']) {
      expect(
        contrast(hex(colors[name]), hex(colors.background)),
        `${mode} ${name} on background`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(hex(colors[name]), hex(colors.surface)),
        `${mode} ${name} on surface`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
