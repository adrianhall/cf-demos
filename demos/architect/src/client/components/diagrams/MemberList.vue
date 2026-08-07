<script setup lang="ts">
import { watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";
import { useDiagramMembersStore } from "../../stores/diagram-members";

/**
 * Read-only member list for one diagram, visible to every member — owner and editor alike.
 *
 * Invite/revoke controls live in `InviteDialog.vue`, rendered only for the owner by
 * `DiagramEditorView.vue` — this component never itself decides who may manage membership; it
 * only ever displays what `GET /api/diagrams/:id/members` returns.
 */
const props = defineProps<{
  /** Diagram whose members to display. */
  diagramId: string;
}>();

const store = useDiagramMembersStore();

watch(
  () => props.diagramId,
  (id) => {
    if (id) {
      void store.load(id);
    }
  },
  { immediate: true },
);
</script>

<template>
  <section aria-labelledby="member-list-heading" class="member-list">
    <h2 id="member-list-heading" class="heading">
      <FeatherIcon name="users" />
      Members
    </h2>
    <v-alert v-if="store.error" type="error" variant="tonal">{{ store.error }}</v-alert>
    <v-progress-circular
      v-else-if="store.loading"
      color="primary"
      indeterminate
      size="20"
      width="2"
    />
    <ul v-else aria-label="Diagram members" class="members">
      <li v-for="member in store.members" :key="member.email">
        <span class="email">{{ member.email }}</span>
        <v-chip :color="member.role === 'owner' ? 'primary' : undefined" size="x-small" variant="tonal">
          {{ member.role }}
        </v-chip>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.member-list {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 1rem;
}
.heading {
  align-items: center;
  display: flex;
  font-size: 0.95rem;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}
.members {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.members li {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.email {
  overflow-wrap: anywhere;
}
</style>
