import "vuetify/styles";
import { createPinia } from "pinia";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { createVuetify } from "vuetify";
import {
  VAlert,
  VApp,
  VBtn,
  VCard,
  VCardText,
  VChip,
  VContainer,
  VMain,
  VPagination,
  VTextField,
} from "vuetify/components";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";
import ReviewDetailView from "./views/ReviewDetailView.vue";

/**
 * Start the browser application (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item
 * 27: "Keep `src/client/main.ts` bootstrap-only"). Two routes: `/` (the trigger form and review
 * history, `HomeView.vue`) and `/reviews/:id` (one run's live/report detail,
 * `ReviewDetailView.vue`).
 */
export function startClient(): void {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { component: HomeView, path: "/" },
      { component: ReviewDetailView, path: "/reviews/:id" },
    ],
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
        VChip,
        VContainer,
        VMain,
        VPagination,
        VTextField,
      },
    }),
  );
  app.mount("#app");
}

startClient();
