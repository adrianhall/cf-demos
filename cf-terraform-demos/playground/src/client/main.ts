import 'vuetify/styles';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import { VApp, VBtn } from 'vuetify/components';
import App from './App.vue';
import { createAppRouter } from './router';

/**
 * Start the browser application: mounts the Vue app with Pinia, Vue Router, and Vuetify.
 *
 * There is no client-side authentication redirect. Cloudflare Access gates every page at the edge
 * before the document request reaches this script (see `infra/access.tf`), so by the time this runs
 * the visitor is already signed in.
 *
 * Only two Vuetify components are registered. The Playground's panels are mostly bespoke — token
 * boxes, media previews, cost tables — so pulling in the whole library would ship a large component
 * set to support a theme and a button. The shell's own layout is plain CSS for the same reason.
 *
 * `VMain` is deliberately absent. It renders a `<main>` of its own, and the shell already has the
 * one main landmark around the routed content; wrapping the whole shell in another would nest the
 * sidebar inside main content and create duplicate main landmarks.
 *
 * @returns Nothing; the application is mounted into `#app`.
 */
export function startClient(): void {
  const app = createApp(App);
  app.use(createPinia());
  app.use(createAppRouter());
  app.use(
    createVuetify({
      components: { VApp, VBtn },
      theme: {
        defaultTheme: 'playgroundDark',
        themes: {
          playgroundDark: {
            colors: {
              'background': '#0b1020',
              'error': '#ff7979',
              'on-surface': '#f6f3ff',
              'on-surface-variant': '#c8c2d6',
              'outline': '#9d95a9',
              'outline-variant': '#454050',
              'primary': '#8ab4ff',
              'surface': '#161b2b',
              'surface-variant': '#242b3f'
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
