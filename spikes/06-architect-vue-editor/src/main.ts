import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "vuetify/styles";
import { createApp } from "vue";
import { createVuetify } from "vuetify";
import App from "./App.vue";
import "./styles.css";

/** Mount the standalone editor spike with Vuetify's default design tokens. */
createApp(App).use(createVuetify()).mount("#app");
