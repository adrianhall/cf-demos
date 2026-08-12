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

/**
 * One shared Vuetify instance for every component test in this project, covering every
 * component used anywhere in `src/client` (`./main.ts`'s own tree-shaken import list) -- kept
 * in one place, rather than duplicated per test file (`demos/url-shortener`'s own per-file
 * convention), since this demo's component tree uses Vuetify components in enough different
 * files that duplicating the list everywhere would drift the moment `main.ts`'s own list
 * changes.
 */
export const testVuetify = createVuetify({
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
});
