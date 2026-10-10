<script setup lang="ts">
import type { Todo } from "../stores/todos";

/** Properties supplied to the task list. */
interface Props {
  /** TODO items for the current authenticated user. */
  todos: Todo[];
}

/** Events emitted by the task list. */
interface Emits {
  /** Request that a task's completion state be changed. */
  complete: [todo: Todo, completed: boolean];
  /** Request deletion of a task. */
  remove: [id: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <section aria-labelledby="todo-list-heading">
    <h2 id="todo-list-heading" class="sr-only">Your tasks</h2>
    <v-card v-if="todos.length === 0" variant="tonal">
      <v-card-text>Nothing on your list yet. Add a task to begin.</v-card-text>
    </v-card>
    <v-list v-else aria-label="Your tasks" class="todo-list" lines="one">
      <v-list-item v-for="todo in todos" :key="todo.id" class="todo-item">
        <template #prepend>
          <input
            :aria-label="`${todo.completed ? 'Mark active' : 'Mark complete'}: ${todo.title}`"
            :checked="todo.completed"
            class="todo-checkbox"
            type="checkbox"
            @change="emit('complete', todo, ($event.target as HTMLInputElement).checked)"
          />
        </template>
        <v-list-item-title class="todo-title" :class="{ completed: todo.completed }">
          {{ todo.title }}
        </v-list-item-title>
        <template #append>
          <v-btn
            :aria-label="`Delete task: ${todo.title}`"
            color="error"
            class="delete-button"
            variant="text"
            @click="emit('remove', todo.id)"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
            </svg>
          </v-btn>
        </template>
      </v-list-item>
    </v-list>
  </section>
</template>

<style scoped>
.completed {
  color: rgb(var(--v-theme-on-surface-variant));
  text-decoration: line-through;
}

.todo-title {
  color: rgb(var(--v-theme-on-surface));
}

.todo-checkbox {
  accent-color: rgb(var(--v-theme-primary));
  block-size: 1.25rem;
  cursor: pointer;
  inline-size: 1.25rem;
}

.todo-item :deep(.v-list-item__prepend) {
  margin-inline-end: 0.25rem;
}

.delete-button svg {
  block-size: 1.375rem;
  fill: currentcolor;
  inline-size: 1.375rem;
}

.sr-only {
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  width: 1px;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.todo-item {
  min-height: 3.5rem;
}
</style>
