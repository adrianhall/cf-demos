<script setup lang="ts">
import type { TaskDescriptor } from '../../tasks';

defineProps<{
  /**
   * The panel being rendered; supplies its name, technical task type, and summary.
   */
  task: TaskDescriptor;
}>();
</script>

<template>
  <article class="panel-page">
    <header class="panel-header">
      <h1 class="panel-title">{{ task.name }}</h1>
      <!--
        The technical task type sits directly under the plain name rather than replacing it. The
        action name is what someone picks from the sidebar; the task type is what they will search
        the model catalog for afterwards. Showing both is how the panel teaches the vocabulary
        instead of assuming it.
      -->
      <p class="panel-task-type">{{ task.taskType }}</p>
      <p class="panel-summary">{{ task.summary }}</p>
      <p v-if="task.gateway === 'required'" class="panel-gateway">Routed through AI Gateway</p>
      <p v-else class="panel-gateway panel-gateway--local">
        Runs in your browser — no inference, no cost
      </p>
    </header>

    <div class="panel-body">
      <slot />
    </div>
  </article>
</template>

<style scoped>
.panel-page {
  margin: 0 auto;
  max-width: 64rem;
  padding: 1.5rem 1.25rem 3rem;
}

.panel-header {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
}

.panel-title {
  font-size: 1.75rem;
  margin: 0;
}

.panel-task-type {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.125rem 0 0;
}

.panel-summary {
  margin: 0.75rem 0 0;
  max-width: 48rem;
}

.panel-gateway {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.panel-gateway::before {
  content: '→ ';
}

.panel-gateway--local::before {
  content: '▣ ';
}
</style>
