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
  VCardActions,
  VCardText,
  VChip,
  VContainer,
  VDialog,
  VList,
  VListItem,
  VMain,
  VProgressCircular,
  VRadio,
  VRadioGroup,
  VSpacer,
  VTextarea,
  VTextField,
} from "vuetify/components";
import App from "./App.vue";
import DiagramEditorView from "./views/DiagramEditorView.vue";
import DiagramLibraryView from "./views/DiagramLibraryView.vue";
import InvitationRedeemView from "./views/InvitationRedeemView.vue";
import LandingView from "./views/LandingView.vue";

/** Start the public landing page and Access-gated application shell. */
export function startClient(): void {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { component: LandingView, path: "/" },
      // `/app` has no page of its own — it exists only so a bookmarked/typed `/app` URL lands
      // somewhere useful once authenticated, without also gating an empty intermediate page
      // Access would already have to authorize.
      { path: "/app", redirect: { name: "diagram-library" } },
      {
        component: DiagramLibraryView,
        name: "diagram-library",
        path: "/app/diagrams",
      },
      {
        component: DiagramEditorView,
        name: "diagram-editor",
        path: "/app/diagrams/:id",
      },
      {
        component: InvitationRedeemView,
        name: "invitation-redeem",
        path: "/app/invitations/:token",
      },
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
        VCardActions,
        VCardText,
        VChip,
        VContainer,
        VDialog,
        VList,
        VListItem,
        VMain,
        VProgressCircular,
        VRadio,
        VRadioGroup,
        VSpacer,
        VTextField,
        VTextarea,
      },
    }),
  );
  app.mount("#app");
}

startClient();
