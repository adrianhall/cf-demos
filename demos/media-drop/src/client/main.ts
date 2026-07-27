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
import LibraryView from "./views/LibraryView.vue";
import StudioView from "./views/StudioView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { component: LibraryView, path: "/" },
    { component: StudioView, path: "/studio" },
  ],
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(
  createVuetify({
    components: { VApp, VBtn, VCard, VCardText, VContainer, VMain },
  }),
);
app.mount("#app");
