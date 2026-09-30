import 'vuetify/styles';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import App from './App.vue';
import { router } from './router';
import { themeConfig } from './theme';

/**
 * Start the browser application with its shared state, addressable navigation, and semantic theme.
 *
 * Components are registered individually by Vuetify's tree-shaking build when imported through the
 * component barrel. The explorer uses a broad but conventional subset (lists, expansion panels,
 * menus, alerts, and form fields); this avoids hand-maintaining an error-prone registration list
 * while Vite still removes components the templates never import.
 *
 * @returns Nothing; mounts the application into `#app`.
 */
export function startClient(): void {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(createVuetify({ components, directives, theme: themeConfig }));
  app.mount('#app');
}

startClient();
