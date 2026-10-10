<script setup lang="ts">
import { onMounted, shallowRef } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import TodoForm from "../components/TodoForm.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import TodoList from "../components/TodoList.vue";
import { useTodosStore, type Todo } from "../stores/todos";

const todos = useTodosStore();
const message = shallowRef<string | null>(null);

/** Display a useful failure message without replacing the user's current task list. */
function showError(cause: unknown, fallback: string): void {
  message.value = cause instanceof Error ? cause.message : fallback;
}

/** Create a task and announce the successful mutation. */
async function create(title: string): Promise<void> {
  message.value = null;
  try {
    await todos.create(title);
    message.value = "Task added.";
  } catch (cause) {
    showError(cause, "Could not add the task.");
  }
}

/** Persist the changed completion state for one task. */
async function complete(todo: Todo, completed: boolean): Promise<void> {
  message.value = null;
  try {
    await todos.setCompleted(todo, completed);
  } catch (cause) {
    showError(cause, "Could not update the task.");
  }
}

/** Delete one task after explicit user intent. */
async function remove(id: string): Promise<void> {
  message.value = null;
  try {
    await todos.remove(id);
    message.value = "Task deleted.";
  } catch (cause) {
    showError(cause, "Could not delete the task.");
  }
}

/** Delete every completed task for the current signed-in user. */
async function clearCompleted(): Promise<void> {
  message.value = null;
  try {
    await todos.clearCompleted();
    message.value = "Completed tasks cleared.";
  } catch (cause) {
    showError(cause, "Could not clear completed tasks.");
  }
}

/** Load the current user's isolated task list when this route is first displayed. */
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
      <v-progress-circular v-if="todos.loading" aria-label="Loading tasks" class="loading" indeterminate />
      <TodoList v-else :todos="todos.todos" @complete="complete" @remove="remove" />
      <footer class="todo-footer" aria-live="polite">
        <span>{{ todos.remaining }} {{ todos.remaining === 1 ? "task" : "tasks" }} remaining</span>
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
