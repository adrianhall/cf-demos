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
  VBreadcrumbs,
  VBtn,
  VCard,
  VCardText,
  VCardTitle,
  VCol,
  VContainer,
  VDialog,
  VEmptyState,
  VForm,
  VList,
  VListItem,
  VListItemSubtitle,
  VListItemTitle,
  VMain,
  VNavigationDrawer,
  VProgressLinear,
  VRow,
  VSkeletonLoader,
  VTextField
} from 'vuetify/components';
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';

/**
 * Light theme. Colours meet WCAG 2.2 AA contrast against their `on-*` pairs.
 */
const igniteLight: ThemeDefinition = {
  dark: false,
  colors: {
    primary: '#B3261E',
    secondary: '#5D4037',
    background: '#FFFBFF',
    surface: '#FFFFFF',
    error: '#B00020',
    info: '#0B57D0',
    warning: '#8A5100',
    success: '#1B6E2D'
  }
};

/**
 * Dark theme counterpart.
 */
const igniteDark: ThemeDefinition = {
  dark: true,
  colors: {
    primary: '#FFB4AB',
    secondary: '#E7BDB0',
    background: '#1A1110',
    surface: '#231918',
    error: '#FFB4AB',
    info: '#A8C7FA',
    warning: '#FFB870',
    success: '#8FD99A'
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
  VBreadcrumbs,
  VBtn,
  VCard,
  VCardText,
  VCardTitle,
  VCol,
  VContainer,
  VDialog,
  VEmptyState,
  VForm,
  VList,
  VListItem,
  VListItemSubtitle,
  VListItemTitle,
  VMain,
  VNavigationDrawer,
  VProgressLinear,
  VRow,
  VSkeletonLoader,
  VTextField
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
      themes: { light: igniteLight, dark: igniteDark }
    },
    defaults: {
      VTextField: { variant: 'outlined', density: 'comfortable' },
      VBtn: { rounded: 'lg' },
      VCard: { rounded: 'lg' }
    }
  });
}
