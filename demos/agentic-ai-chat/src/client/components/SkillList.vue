<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import type { Skill } from "../stores/skills";

/** Properties supplied to the skill list (docs/06-AGENTIC-CHAT.md Phase 11, US-10) -- shared by
 * `SkillsView.vue`'s personal-skill list and `AdminView.vue`'s enterprise-skill list. */
interface Props {
  /** The skills to render, most recently added first (already sorted by the caller's own
   * `GET /api/skills`/`GET /api/admin/skills` response order). */
  skills: readonly Skill[];
  /** `true` while the list's very first load is in flight. */
  loading: boolean;
  /** What an empty list should say -- distinct wording for a personal vs. enterprise list. */
  emptyMessage: string;
}

/** Events emitted by the list. */
interface Emits {
  /** Request removal of an existing skill. */
  remove: [id: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <div class="skill-list">
    <p v-if="loading && skills.length === 0" class="empty-state">Loading skills…</p>
    <p v-else-if="skills.length === 0" class="empty-state">{{ emptyMessage }}</p>
    <ul v-else aria-label="Skills">
      <li v-for="skill in skills" :key="skill.id" class="skill-item">
        <span class="skill-source">
          <FeatherIcon
            aria-hidden="true"
            size="16"
            :type="skill.sourceType === 'url' ? 'link' : 'file-text'"
          />
        </span>
        <span class="skill-text">
          <span class="skill-name">{{ skill.name }}</span>
          <span class="skill-ref">{{ skill.sourceRef ?? "Uploaded content" }}</span>
        </span>
        <button
          class="remove-button"
          :aria-label="`Delete skill ${skill.id}`"
          type="button"
          @click="emit('remove', skill.id)"
        >
          <FeatherIcon aria-hidden="true" size="14" type="x" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.skill-list ul {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.skill-item {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.skill-source {
  align-items: center;
  color: rgb(var(--v-theme-on-surface-variant));
  display: inline-flex;
}

.skill-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.skill-name {
  font-weight: 600;
}

.skill-ref {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
}

.remove-button {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  min-height: 2.25rem;
  min-width: 2.25rem;
  opacity: 0.7;
}

.remove-button:hover,
.remove-button:focus-visible {
  opacity: 1;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}
</style>
