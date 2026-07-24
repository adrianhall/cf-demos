import "vuetify/styles";
import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { createVuetify } from "vuetify";
import {
  VAlert,
  VApp,
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VChip,
  VContainer,
  VDialog,
  VList,
  VListItem,
  VMain,
  VProgressCircular,
  VSpacer,
  VTextField,
} from "vuetify/components";
import { Ripple } from "vuetify/directives";
import App from "./App.vue";
import AdminView from "./views/AdminView.vue";

/**
 * Start the browser application, forcing `/` through an Access-protected document request.
 *
 * @param browserLocation - Browser location used to inspect and replace the current URL.
 */
export function startClient(
  browserLocation: Pick<Location, "pathname" | "replace"> = window.location,
): void {
  if (browserLocation.pathname === "/") {
    browserLocation.replace("/admin");
    return;
  }

  const router = createRouter({
    history: createWebHistory(),
    routes: [{ component: AdminView, path: "/admin" }],
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
        VCardActions,
        VCardText,
        VChip,
        VContainer,
        VDialog,
        VList,
        VListItem,
        VMain,
        VProgressCircular,
        VSpacer,
        VTextField,
      },
      directives: { Ripple },
    }),
  );
  app.mount("#app");
}

startClient();
