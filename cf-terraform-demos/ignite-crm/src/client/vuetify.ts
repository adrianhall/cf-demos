/**
 * @file The single Vuetify instance: explicit component registration and the one application theme.
 *   Components are registered by name rather than through the whole-library plugin, so the SPA
 *   bundle carries only what it renders. Add a component here when a view starts using it. The
 *   theme is the only source of colour, density, and typography; application CSS does not restyle
 *   Vuetify internals.
 */

import { createVuetify, type ThemeDefinition } from 'vuetify';
import {
  VAlert,
  VApp,
  VAppBar,
  VAppBarNavIcon,
  VAppBarTitle,
  VAutocomplete,
  VBreadcrumbs,
  VBtn,
  VBtnToggle,
  VCard,
  VCardActions,
  VCardText,
  VCardTitle,
  VCheckbox,
  VChip,
  VCol,
  VContainer,
  VDataTable,
  VDialog,
  VEmptyState,
  VForm,
  VIcon,
  VList,
  VListItem,
  VListItemSubtitle,
  VListItemTitle,
  VMain,
  VMenu,
  VNavigationDrawer,
  VProgressLinear,
  VRadio,
  VRadioGroup,
  VRow,
  VSelect,
  VSkeletonLoader,
  VTable,
  VTextField,
  VTimeline,
  VTimelineItem,
  VTextarea
} from 'vuetify/components';
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';

/**
 * Brand anchors: Cloudflare orange (primary) and periwinkle blue (secondary).
 *
 * Both themes use these exact hues as the filled `primary`/`secondary` colours. Neither has enough
 * contrast with white text, so their `on-*` text colours are dark (orange with `#1C1B1F` is 6.6:1;
 * blue with `#0B0F2E` is 4.6:1). As _text_ on a light surface they fall below WCAG 2.2 AA (orange
 * on white is 2.6:1), so each theme also defines a `*-strong` tone: a darker shade in light mode
 * and a lighter tint in dark mode, at least 4.5:1 against the surfaces it appears on. Use
 * `*-strong` wherever the brand colour becomes text or a focus indicator: tonal cards, active
 * navigation, focused fields. The `*-container` pair is a soft fill with its own high-contrast
 * text, for banners and highlights.
 *
 * `variations` also has Vuetify generate `primary-lighten-1…3` and `primary-darken-1…3` (and the
 * same for secondary) for decorative use.
 */
const BRAND_ORANGE = '#FC7C1E';
const BRAND_BLUE = '#5A73F4';

/**
 * Lighten/darken steps Vuetify generates for both brand colours.
 */
const variations = { colors: ['primary', 'secondary'], lighten: 3, darken: 3 };

/**
 * Light theme. Contrast ratios are noted against the colour each is paired with.
 */
const igniteLight: ThemeDefinition = {
  dark: false,
  colors: {
    'primary': BRAND_ORANGE,
    'on-primary': '#1C1B1F',
    'primary-strong': '#A84800', // 5.6:1 on background, 5.2:1 on its tonal tint
    'primary-container': '#FFE0C7',
    'on-primary-container': '#5C2600', // 9.7:1
    'secondary': BRAND_BLUE,
    'on-secondary': '#0B0F2E', // 4.6:1
    'secondary-strong': '#3B4FCC', // 6.3:1 on background, 5.8:1 on its tonal tint
    'secondary-container': '#DFE3FF',
    'on-secondary-container': '#1F2C8A', // 9.3:1
    'background': '#FFF8F3',
    'on-background': '#1C1B1F', // 16.3:1
    'surface': '#FFFFFF',
    'on-surface': '#1C1B1F', // 17.1:1
    'error': '#B00020',
    'info': '#3B4FCC',
    'warning': '#8A5100',
    'success': '#1B6E2D'
  },
  // Vuetify's default emphasis opacities (0.60 medium, 0.38 disabled) blend `on-surface` to about
  // 4.4:1 and 2.1:1 on our warm background — below WCAG 1.4.3 for subtitles, hints, field labels,
  // and the current breadcrumb. These keep every emphasis level at least 4.5:1 on background,
  // surface, and the tonal container tint (a field label is medium × high emphasis: 4.8:1; disabled is 4.7:1).
  variables: {
    'high-emphasis-opacity': 0.9,
    'medium-emphasis-opacity': 0.74,
    'disabled-opacity': 0.62
  }
};

/**
 * Dark theme. The warm near-black surfaces keep the orange from looking neon.
 */
const igniteDark: ThemeDefinition = {
  dark: true,
  colors: {
    'primary': BRAND_ORANGE,
    'on-primary': '#1E1A17', // 6.6:1
    'primary-strong': '#FFB37A', // 9.9:1 on background, 8.7:1 on surface
    'primary-container': '#7A3300',
    'on-primary-container': '#FFE0C7', // 7.3:1
    'secondary': BRAND_BLUE,
    'on-secondary': '#0B0F2E', // 4.6:1
    'secondary-strong': '#A3B0FA', // 8.4:1 on background, 7.4:1 on surface
    'secondary-container': '#2A3AA8',
    'on-secondary-container': '#DFE3FF', // 7.3:1
    'background': '#1E1A17',
    'on-background': '#E8E1DC', // 13.4:1
    'surface': '#2B241F',
    'on-surface': '#E8E1DC',
    'error': '#FFB4AB',
    'info': '#A3B0FA',
    'warning': '#FFB870',
    'success': '#8FD99A'
  },
  // As in light: medium 7.1:1+, and a disabled label stays legible (Vuetify's 0.50 is 2.8:1).
  variables: {
    'medium-emphasis-opacity': 0.74,
    'disabled-opacity': 0.7
  }
};

/**
 * Every component the SPA renders.
 */
export const components = {
  VAlert,
  VApp,
  VAppBar,
  VAppBarNavIcon,
  VAppBarTitle,
  VAutocomplete,
  VBreadcrumbs,
  VBtn,
  VBtnToggle,
  VCard,
  VCardActions,
  VCardText,
  VCardTitle,
  VCheckbox,
  VChip,
  VCol,
  VContainer,
  VDataTable,
  VDialog,
  VEmptyState,
  VForm,
  VIcon,
  VList,
  VListItem,
  VListItemSubtitle,
  VListItemTitle,
  VMain,
  VMenu,
  VNavigationDrawer,
  VProgressLinear,
  VRadio,
  VRadioGroup,
  VRow,
  VSelect,
  VSkeletonLoader,
  VTable,
  VTextarea,
  VTextField,
  VTimeline,
  VTimelineItem
};

/**
 * Create the application's Vuetify instance.
 *
 * @returns The Vuetify plugin.
 */
export function createAppVuetify(): ReturnType<typeof createVuetify> {
  return createVuetify({
    components,
    directives: {},
    icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
    theme: {
      defaultTheme: 'system',
      variations,
      themes: { light: igniteLight, dark: igniteDark }
    },
    defaults: {
      // Brand colour as text or a focus ring uses the `*-strong` tone (see the theme notes above).
      VTextField: { variant: 'outlined', density: 'comfortable', color: 'primary-strong' },
      VListItem: { color: 'primary-strong' },
      VSelect: { variant: 'outlined', density: 'comfortable', color: 'primary-strong' },
      VAutocomplete: { variant: 'outlined', density: 'comfortable', color: 'primary-strong' },
      VTextarea: { variant: 'outlined', density: 'comfortable', color: 'primary-strong' },
      VCheckbox: { color: 'primary-strong' },
      VRadio: { color: 'primary-strong' },
      VBtn: { rounded: 'lg' },
      VCard: { rounded: 'lg' }
    }
  });
}
