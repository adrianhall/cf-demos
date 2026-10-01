<script setup lang="ts">
import { computed } from 'vue';
import { TASK_DESCRIPTORS, type TaskDescriptor, type TaskGroup } from '../../../tasks';

/**
 * Panels bucketed by their visual group, in catalogue order.
 *
 * The grouping is presentational only. Each group renders as a plain heading followed by its links;
 * the heading is not a button, a disclosure, or a route, and every panel is reachable in exactly
 * one click from anywhere. That keeps the navigation one level deep, which is the whole point of
 * naming the panels after actions rather than nesting them under "studios".
 */
const groups = computed<{ name: TaskGroup; tasks: TaskDescriptor[] }[]>(() => {
  const ordered: { name: TaskGroup; tasks: TaskDescriptor[] }[] = [];
  for (const task of TASK_DESCRIPTORS) {
    const existing = ordered.find((group) => group.name === task.group);
    if (existing) {
      existing.tasks.push(task);
    } else {
      ordered.push({ name: task.group, tasks: [task] });
    }
  }
  return ordered;
});
</script>

<template>
  <nav class="panel-navigation" aria-label="Playground panels">
    <template v-for="group in groups" :key="group.name">
      <!--
        A plain heading, deliberately not a `v-list-subheader` button or an expansion panel. It
        labels the links beneath it for a sighted visitor and for a screen-reader user navigating
        by heading, without becoming something that can be clicked, focused, or collapsed.
      -->
      <h2 class="group-heading">{{ group.name }}</h2>
      <ul class="group-list">
        <li v-for="task in group.tasks" :key="task.id">
          <router-link
            :to="`/${task.id}`"
            class="panel-link"
            :data-task="task.id"
            active-class="panel-link--active"
          >
            <span class="panel-name">{{ task.name }}</span>
            <span v-if="task.availability === 'planned'" class="panel-badge">
              Phase {{ task.phase }}
            </span>
          </router-link>
        </li>
      </ul>
    </template>
  </nav>
</template>

<style scoped>
.panel-navigation {
  padding: 0.5rem 0.75rem 1.5rem;
}

.group-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 1.25rem 0 0.375rem 0.5rem;
  text-transform: uppercase;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.panel-link {
  align-items: center;
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  gap: 0.5rem;
  /* Comfortably above the 24x24 CSS-pixel minimum target size, with room for a 16px label. */
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  text-decoration: none;
}

.panel-link:hover,
.panel-link:focus-visible {
  background-color: rgb(var(--v-theme-surface-variant));
}

.panel-link--active {
  background-color: rgb(var(--v-theme-surface-variant));
  font-weight: 700;
}

.panel-name {
  flex: 1 1 auto;
}

.panel-badge {
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface-variant));
  flex: 0 0 auto;
  font-size: 0.6875rem;
  padding: 0.0625rem 0.5rem;
}
</style>
