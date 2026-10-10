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
  VCardItem,
  VCardText,
  VChip,
  VContainer,
  VFileInput,
  VMain,
  VProgressLinear,
  VRow,
  VCol,
  VSpacer,
  VTextField,
} from "vuetify/components";
import App from "./App.vue";
import LibraryView from "./views/LibraryView.vue";
import MediaDetailView from "./views/MediaDetailView.vue";
import StudioView from "./views/StudioView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { component: LibraryView, path: "/" },
    { component: MediaDetailView, path: "/media/:id" },
    { component: StudioView, path: "/studio" },
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
      VCardItem,
      VCardText,
      VChip,
      VCol,
      VContainer,
      VFileInput,
      VMain,
      VProgressLinear,
      VRow,
      VSpacer,
      VTextField,
    },
    theme: {
      defaultTheme: "mediaDrop",
      themes: {
        mediaDrop: {
          colors: {
            background: "#f5f8ff",
            primary: "#2458d3",
            secondary: "#075b63",
            surface: "#ffffff",
            "surface-variant": "#e9eefb",
          },
          dark: false,
        },
      },
    },
  }),
);
app.mount("#app");
