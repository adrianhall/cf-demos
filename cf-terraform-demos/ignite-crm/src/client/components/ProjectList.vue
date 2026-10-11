<script setup lang="ts">
/**
 * A compact list of delivery projects with status, lead, and task progress. A composition of
 * Vuetify list and chip primitives, used on contact and company timelines so sales and delivery
 * context appear together.
 */
import type { Project } from '../../shared/api/projects.ts';
import { PROJECT_STATUS_VIEW } from './taskLabels.ts';

defineProps<{
  /**
   * Projects to list.
   */
  projects: readonly Project[];
  /**
   * Text shown when there are none.
   */
  emptyText?: string;
}>();

/**
 * Open (not done) task count.
 *
 * @param project The project.
 * @returns The count.
 */
function openTasks(project: Project): number {
  const counts = project.taskCounts;
  return counts.todo + counts.in_progress + counts.in_review;
}
</script>

<template>
  <v-list lines="two" aria-label="Projects">
    <v-list-item
      v-for="project in projects"
      :key="project.id"
      :to="{ name: 'project', params: { id: project.id } }"
    >
      <v-list-item-title class="text-wrap">{{ project.name }}</v-list-item-title>
      <v-list-item-subtitle class="text-wrap">
        <v-chip
          :color="PROJECT_STATUS_VIEW[project.status].color"
          size="x-small"
          variant="tonal"
          label
          class="mr-2"
          >{{ PROJECT_STATUS_VIEW[project.status].label }}</v-chip
        >
        Lead {{ project.lead.displayName }} · {{ openTasks(project) }} open,
        {{ project.taskCounts.done }} done
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="projects.length === 0" :title="emptyText ?? 'No projects yet.'" />
  </v-list>
</template>
