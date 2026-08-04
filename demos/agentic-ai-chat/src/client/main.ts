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
import AdminView from "./views/AdminView.vue";
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
    routes: [
      { component: HomeView, path: "/" },
      // Docs/06-AGENTIC-CHAT.md Phase 7, US-6: the admin console's own nav entry point
      // (`App.vue`'s "Admin console" link) is only ever hidden for a non-administrator
      // identity, never a route guard here -- `requireAdmin()` on the Worker is the real
      // enforcement (Section 6.5's "never trust the client-hidden nav item alone" rule).
      { component: AdminView, path: "/admin" },
    ],
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
