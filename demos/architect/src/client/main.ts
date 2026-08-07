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
  VProgressCircular,
} from "vuetify/components";
import App from "./App.vue";
import EditorShellView from "./views/EditorShellView.vue";
import LandingView from "./views/LandingView.vue";

/** Start the public landing page and Access-gated application shell. */
export function startClient(): void {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { component: LandingView, path: "/" },
      { component: EditorShellView, path: "/app" },
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
        VProgressCircular,
      },
    }),
  );
  app.mount("#app");
}

startClient();
