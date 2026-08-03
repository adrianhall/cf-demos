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
  VMain,
} from "vuetify/components";
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
      components: {
        VApp,
        VBtn,
        VCard,
        VCardText,
        VContainer,
        VMain,
      },
      theme: {
        defaultTheme: "agenticChat",
        themes: {
          agenticChat: {
            colors: {
              background: "#f5f6fa",
              "on-primary": "#1a1a1a",
              "on-surface": "#1f2430",
              "on-surface-variant": "#5b6472",
              outline: "#8d94a3",
              "outline-variant": "#d7dce6",
              primary: "#f6821f",
              secondary: "#052e60",
              surface: "#ffffff",
              "surface-variant": "#eef1f8",
            },
            dark: false,
          },
        },
      },
    }),
  );
  app.mount("#app");
}

startClient();
