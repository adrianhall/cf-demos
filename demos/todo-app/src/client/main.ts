import "vuetify/styles";
import { createPinia } from "pinia";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { createVuetify } from "vuetify";
import {
  VApp,
  VBtn,
  VCard,
  VCardText,
  VContainer,
  VList,
  VListItem,
  VListItemTitle,
  VMain,
  VProgressCircular,
  VTextField,
} from "vuetify/components";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";

/**
 * Start the browser application: mounts the Vue app with Pinia, Vue Router, and Vuetify.
 *
 * Cloudflare Access gates every page at the edge before the document request reaches this
 * script (see AGENTS.md's Public Access section), so no client-side authentication redirect is
 * needed here, unlike `demos/url-shortener`.
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
      components: {
        VApp,
        VBtn,
        VCard,
        VCardText,
        VContainer,
        VList,
        VListItem,
        VListItemTitle,
        VMain,
        VProgressCircular,
        VTextField,
      },
      theme: {
        defaultTheme: "todoDark",
        themes: {
          todoDark: {
            colors: {
              background: "#0b1020",
              error: "#ff7979",
              "on-surface": "#f6f3ff",
              "on-surface-variant": "#d0c8dc",
              outline: "#a59caf",
              "outline-variant": "#4b4554",
              primary: "#8ab4ff",
              surface: "#171d2e",
              "surface-variant": "#252d42",
            },
            dark: true,
          },
        },
      },
    }),
  );
  app.mount("#app");
}

startClient();
