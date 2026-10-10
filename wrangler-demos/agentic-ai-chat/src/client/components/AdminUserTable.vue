<script setup lang="ts">
import type { AdminUser, Business, Geo } from "../stores/admin";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { BUSINESS_VALUES, GEO_VALUES } from "../stores/admin";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import UsageBadge from "./UsageBadge.vue";

/** Properties supplied to the admin console's ranked user-cost table (docs/06-AGENTIC-CHAT.md
 * Phase 7, US-6). */
interface Props {
  /** Every signed-in user, ranked by total cost descending -- already sorted by the caller
   * (`GET /api/admin/users`'s own response order). */
  users: readonly AdminUser[];
  /** `true` while the table's very first load is in flight. */
  loading: boolean;
}

/** Events emitted by the table. */
interface Emits {
  /** Request that a user's business/geo segments be changed. Always carries both fields
   * together (see `useAdminStore.updateMetadata()`'s own JSDoc for why). */
  "update-metadata": [
    email: string,
    business: Business | null,
    geo: Geo | null,
  ];
}

defineProps<Props>();
const emit = defineEmits<Emits>();

/** Title-case a lowercase enum literal for display (`"field"` -> `"Field"`). */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Forward a business `<select>`'s chosen value, carrying the row's current `geo` unchanged. */
function onBusinessChange(user: AdminUser, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit(
    "update-metadata",
    user.email,
    value === "" ? null : (value as Business),
    user.geo,
  );
}

/** Forward a geo `<select>`'s chosen value, carrying the row's current `business` unchanged. */
function onGeoChange(user: AdminUser, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit(
    "update-metadata",
    user.email,
    user.business,
    value === "" ? null : (value as Geo),
  );
}
</script>

<template>
  <div class="admin-user-table">
    <p v-if="loading && users.length === 0" class="empty-state">
      Loading users…
    </p>
    <p v-else-if="users.length === 0" class="empty-state">
      No users have signed in yet.
    </p>
    <table v-else>
      <caption class="table-caption">
        Users ranked by total cost, highest first
      </caption>
      <thead>
        <tr>
          <th scope="col">User</th>
          <th scope="col">Business</th>
          <th scope="col">Geo</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.email">
          <th scope="row">
            {{ user.email }}
            <span v-if="user.isAdmin" class="admin-tag">Administrator</span>
          </th>
          <td>
            <select
              :aria-label="`Business for ${user.email}`"
              :value="user.business ?? ''"
              @change="onBusinessChange(user, $event)"
            >
              <option value="">Unspecified</option>
              <option
                v-for="value in BUSINESS_VALUES"
                :key="value"
                :value="value"
              >
                {{ label(value) }}
              </option>
            </select>
          </td>
          <td>
            <select
              :aria-label="`Geo for ${user.email}`"
              :value="user.geo ?? ''"
              @change="onGeoChange(user, $event)"
            >
              <option value="">Unspecified</option>
              <option v-for="value in GEO_VALUES" :key="value" :value="value">
                {{ value.toUpperCase() }}
              </option>
            </select>
          </td>
          <td>
            <UsageBadge compact :usage="user.usage" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.admin-user-table {
  overflow-x: auto;
}

table {
  border-collapse: collapse;
  width: 100%;
}

.table-caption {
  clip: rect(0 0 0 0);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

th,
td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.5rem 0.75rem;
  text-align: start;
  vertical-align: middle;
}

thead th {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  text-transform: uppercase;
}

tbody th[scope="row"] {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}

.admin-tag {
  background: rgb(var(--v-theme-primary));
  border-radius: 0.75rem;
  color: rgb(var(--v-theme-surface));
  font-size: 0.6875rem;
  font-weight: 700;
  margin-left: 0.5rem;
  padding: 0.0625rem 0.4375rem;
  text-transform: uppercase;
}

select {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}
</style>
