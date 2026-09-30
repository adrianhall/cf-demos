<script setup lang="ts">
import { onMounted, ref } from 'vue';
import TodoForm from '../components/TodoForm.vue';
import TodoList from '../components/TodoList.vue';
import { useTodosStore } from '../stores/todos';

const todos = useTodosStore();
const message = ref<string | null>(null);

/**
 * Show a user-safe failure message without discarding the current list.
 *
 * Each action resolves its own message rather than leaving a stale one on screen, and the list
 * itself is left untouched: a failed write means local state already matches the server.
 *
 * @param cause Value thrown by a store action.
 * @param fallback Message to show when `cause` carries nothing displayable.
 */
function showError(cause: unknown, fallback: string): void {
  message.value = cause instanceof Error ? cause.message : fallback;
}

/**
 * Create a task and confirm the result to the user.
 *
 * @param title Trimmed, non-empty title emitted by the form.
 * @returns A promise fulfilled once the task is created or a failure message is shown.
 */
async function create(title: string): Promise<void> {
  message.value = null;
  try {
    await todos.create(title);
    message.value = 'Task added.';
  } catch (cause) {
    showError(cause, 'Could not add the task.');
  }
}

/**
 * Persist the changed completion state of one task.
 *
 * No success message is shown: the checkbox and strikethrough styling already reflect the outcome,
 * so an extra line of text would be noise.
 *
 * @param id Identifier of the task being toggled.
 * @param completed Desired completion state.
 * @returns A promise fulfilled once the change is persisted or a failure message is shown.
 */
async function complete(id: string, completed: boolean): Promise<void> {
  message.value = null;
  try {
    await todos.setCompleted(id, completed);
  } catch (cause) {
    showError(cause, 'Could not update the task.');
  }
}

/**
 * Delete one task.
 *
 * @param id Identifier of the task to delete.
 * @returns A promise fulfilled once the task is deleted or a failure message is shown.
 */
async function remove(id: string): Promise<void> {
  message.value = null;
  try {
    await todos.remove(id);
    message.value = 'Task deleted.';
  } catch (cause) {
    showError(cause, 'Could not delete the task.');
  }
}

/**
 * Delete every completed task for the signed-in user.
 *
 * @returns A promise fulfilled once the tasks are cleared or a failure message is shown.
 */
async function clearCompleted(): Promise<void> {
  message.value = null;
  try {
    await todos.clearCompleted();
    message.value = 'Completed tasks cleared.';
  } catch (cause) {
    showError(cause, 'Could not clear completed tasks.');
  }
}

/**
 * Load the signed-in user's task list when the route is first displayed.
 *
 * `load` records its own failure in the store rather than throwing, so a failed initial fetch is
 * surfaced here as a message instead of an unhandled rejection.
 */
onMounted(async () => {
  await todos.load();
  if (todos.error) {
    message.value = todos.error;
  }
});
</script>

<template>
  <v-container class="todo-page" max-width="896">
    <section class="intro" aria-labelledby="tasks-heading">
      <p class="eyebrow">Cloudflare Access + D1</p>
      <h1 id="tasks-heading">Your task list</h1>
      <p class="subtitle">Tasks are private to your signed-in Cloudflare Access identity.</p>
    </section>

    <v-card class="todo-card" elevation="3">
      <v-card-text>
        <TodoForm @create="create" />
      </v-card-text>
      <v-progress-circular
        v-if="todos.loading"
        aria-label="Loading tasks"
        class="loading"
        indeterminate
      />
      <TodoList v-else :todos="todos.todos" @complete="complete" @remove="remove" />
      <footer class="todo-footer">
        <span aria-live="polite">
          {{ todos.remaining }} {{ todos.remaining === 1 ? 'task' : 'tasks' }} remaining
        </span>
        <v-btn :disabled="!todos.hasCompleted" variant="text" @click="clearCompleted">
          Clear completed items
        </v-btn>
      </footer>
    </v-card>

    <p v-if="message" class="status" role="status">{{ message }}</p>
  </v-container>
</template>

<style scoped>
.todo-page {
  padding-bottom: 3rem;
  padding-top: 2rem;
}

.intro {
  margin-bottom: 1.5rem;
}

.eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
}

.subtitle {
  color: rgb(var(--v-theme-on-surface));
  margin-top: 0.5rem;
}

.todo-card {
  overflow: hidden;
}

.loading {
  display: block;
  margin: 2rem auto;
}

.todo-footer {
  align-items: center;
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  font-size: 0.875rem;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
}

.status {
  margin-top: 1rem;
}
</style>
