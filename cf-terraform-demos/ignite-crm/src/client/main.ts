/**
 * @file SPA entry: mounts the shell with the router and the application's Vuetify instance.
 *   Cloudflare Access gates the page at the edge before this script loads, so there is no
 *   client-side sign-in flow; the shell loads `/api/v1/session` on mount.
 */

import 'vuetify/styles';
import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './router/index.ts';
import { createAppVuetify } from './vuetify.ts';

createApp(App).use(createAppRouter()).use(createAppVuetify()).mount('#app');
