<script setup lang="ts">
import { computed, onMounted } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import AdminReportTable from "../components/AdminReportTable.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import AdminUserTable from "../components/AdminUserTable.vue";
import { useAdminStore } from "../stores/admin";

const admin = useAdminStore();

/** Title-case a lowercase enum literal for display (`"field"` -> `"Field"`) -- mirrors
 * `AdminUserTable.vue`'s own `label()` helper, so a business segment reads the same way in both
 * the ranked table's dropdown and this report. */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `admin.byBusiness`, resolved to display-ready rows for `AdminReportTable` (a `null` segment
 * becomes the label "Unspecified" -- docs/06-AGENTIC-CHAT.md Phase 7, US-6). */
const businessRows = computed(() =>
  admin.byBusiness.map((row) => ({
    label: row.business === null ? "Unspecified" : label(row.business),
    usage: row.usage,
  })),
);

/** `admin.byGeo`, resolved the same way as {@link businessRows}. */
const geoRows = computed(() =>
  admin.byGeo.map((row) => ({
    label: row.geo?.toUpperCase() ?? "Unspecified",
    usage: row.usage,
  })),
);

// This view's own nav entry point (`App.vue`'s "Admin console" link) is only ever hidden for a
// non-administrator identity, never a route guard -- Section 6.5's "never trust the client-
// hidden nav item alone" rule. `requireAdmin()` is the real enforcement: a non-admin who
// navigates here directly sees `admin.error` (a 403 problem-detail message) below, not a
// crash or a silently empty page.
onMounted(() => void admin.load());
</script>

<template>
  <v-container class="admin-view" fluid>
    <header class="admin-header">
      <h1>Admin Console</h1>
      <router-link class="back-link" to="/">Back to chat</router-link>
    </header>

    <p v-if="admin.error" class="notice notice-error" role="alert">
      {{ admin.error }}
    </p>

    <template v-else>
      <section aria-label="Users by cost">
        <h2>Users by cost</h2>
        <AdminUserTable
          :loading="admin.loading"
          :users="admin.users"
          @update-metadata="admin.updateMetadata"
        />
      </section>

      <section aria-label="Cost by business">
        <h2>Cost by business</h2>
        <AdminReportTable label-header="Business" :rows="businessRows" />
      </section>

      <section aria-label="Cost by geo">
        <h2>Cost by geo</h2>
        <AdminReportTable label-header="Geo" :rows="geoRows" />
      </section>
    </template>
  </v-container>
</template>

<style scoped>
.admin-view {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 64rem;
  padding: 1.5rem;
}

.admin-header {
  align-items: center;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.admin-header h1 {
  font-size: 1.25rem;
  margin: 0;
}

.back-link {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-decoration: none;
}

.back-link:hover,
.back-link:focus-visible {
  text-decoration: underline;
}

section h2 {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.notice {
  margin: 0.75rem 0;
}

.notice-error {
  color: #b3261e;
  font-weight: 600;
}
</style>
