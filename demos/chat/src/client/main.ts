import "vuetify/styles";
import { createPinia } from "pinia";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { createVuetify } from "vuetify";
import { VApp, VContainer, VMain } from "vuetify/components";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";

/**
 * Start the browser application: mounts the Vue app with Pinia, Vue Router, and Vuetify.
 *
 * Cloudflare Access gates every page at the edge before the document request reaches this
 * script (see AGENTS.md's Public Access section), so no client-side authentication redirect is
 * needed here.
 */
export function startClient(): void {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ component: HomeView, path: "/" }],
  });
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(
    createVuetify({
      components: { VApp, VContainer, VMain },
    }),
  );
  app.mount("#app");
}

startClient();
