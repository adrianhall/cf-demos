import type { ThemeDefinition } from 'vuetify';

/**
 * @file Theme definitions for the explorer.
 *
 *   ## Dark now, switchable later
 *
 *   The demo ships dark, but the structure here anticipates a dark/light/system control without
 *   building one. Two complete themes are defined and registered; `defaultTheme` simply picks one.
 *   Adding the switch later is then a matter of writing `theme.global.name.value = …` against a
 *   theme that already exists and has already been checked for contrast — rather than discovering
 *   at that point that every component hard-coded a dark colour. What makes that work is that **no
 *   component names a colour**. Everything reads Vuetify's semantic tokens (`surface`,
 *   `on-surface`, `on-surface-variant`, `outline`, `primary`), so the same markup renders correctly
 *   under either theme. A component that wrote `#0b1020` directly would silently break the light
 *   theme, so the palettes live only here.
 *
 *   ## Contrast
 *
 *   UISPEC §14 requires the de-emphasised sentinel and provenance text to stay readable —
 *   "de-emphasised" must not become "unreadable". That text uses `on-surface-variant`, so the value
 *   below is chosen to clear WCAG AA (4.5:1) against `surface` rather than being a faded version of
 *   the body colour. The checks are in `tests/client/theme.test.ts`.
 */

/**
 * Dark theme, and the demo's default.
 *
 * A deep, slightly blue neutral rather than pure black: the explorer shows three columns side by
 * side, and distinguishing them needs a surface that can be lightened for a raised panel and
 * darkened for the page behind it. Pure black leaves nowhere to go in one of those directions.
 */
export const swapiDarkTheme: ThemeDefinition = {
  dark: true,
  colors: {
    'background': '#0b1020',
    'surface': '#151b2e',
    'surface-variant': '#222a41',
    'on-surface': '#f2f4fb',
    // Lightened well past a typical muted grey so secondary text clears AA on `surface`.
    'on-surface-variant': '#b9c0d4',
    'primary': '#8ab4ff',
    'on-primary': '#0b1020',
    'secondary': '#ffd479',
    'error': '#ff8a8a',
    'outline': '#8b93a8',
    'outline-variant': '#3a4257'
  }
};

/**
 * Light theme, defined but not selected.
 *
 * Present so the future tri-switch has something to switch to, and so the "no component names a
 * colour" rule is enforced rather than merely intended — the theme tests render against both.
 */
export const swapiLightTheme: ThemeDefinition = {
  dark: false,
  colors: {
    'background': '#f4f6fc',
    'surface': '#ffffff',
    'surface-variant': '#eaeef8',
    'on-surface': '#121727',
    'on-surface-variant': '#4a5168',
    'primary': '#1f5fd0',
    'on-primary': '#ffffff',
    'secondary': '#8a6100',
    'error': '#b3261e',
    'outline': '#6b7288',
    'outline-variant': '#c6cbdb'
  }
};

/**
 * Name of the dark theme, used as the default and by the tests.
 */
export const DARK_THEME_NAME = 'swapiDark';

/**
 * Name of the light theme.
 */
export const LIGHT_THEME_NAME = 'swapiLight';

/**
 * Vuetify theme configuration for the application.
 *
 * Both themes are registered even though only one is reachable today, which is what keeps the
 * eventual switch a one-line change.
 */
export const themeConfig = {
  defaultTheme: DARK_THEME_NAME,
  themes: {
    [DARK_THEME_NAME]: swapiDarkTheme,
    [LIGHT_THEME_NAME]: swapiLightTheme
  }
} as const;
