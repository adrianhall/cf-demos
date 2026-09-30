import 'vuetify/styles';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { createVuetify } from 'vuetify';
import {
  VAlert,
  VApp,
  VBtn,
  VCard,
  VCardText,
  VList,
  VListItem,
  VListItemTitle,
  VMain,
  VProgressCircular,
  VTextField
} from 'vuetify/components';
import App from './App.vue';
import HomeView from './views/HomeView.vue';

/**
 * Start the browser application: mounts the Vue app with Pinia, Vue Router, and Vuetify.
 *
 * There is no client-side authentication redirect. Cloudflare Access gates every page at the edge
 * before the document request reaches this script (see `infra/access.tf`), so by the time this runs
 * the visitor is already signed in — unlike the sibling `link` demo, which has a public surface and
 * therefore has to steer the browser towards its protected area.
 *
 * Vuetify components are registered individually rather than via the whole-library plugin so the
 * production bundle contains only what this application actually renders.
 *
 * @returns Nothing; the application is mounted into `#app`.
 */
export function startClient(): void {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ component: HomeView, path: '/' }]
  });
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(
    createVuetify({
      components: {
        VAlert,
        VApp,
        VBtn,
        VCard,
        VCardText,
        VList,
        VListItem,
        VListItemTitle,
        VMain,
        VProgressCircular,
        VTextField
      },
      theme: {
        defaultTheme: 'chatDark',
        themes: {
          chatDark: {
            colors: {
              'background': '#0b1020',
              'error': '#ff7979',
              'on-primary': '#0b1020',
              'on-surface': '#f6f3ff',
              'on-surface-variant': '#d0c8dc',
              'outline': '#a59caf',
              'outline-variant': '#4b4554',
              'primary': '#8ab4ff',
              'surface': '#171d2e',
              'surface-variant': '#252d42'
            },
            dark: true
          }
        }
      }
    })
  );
  app.mount('#app');
}

startClient();
