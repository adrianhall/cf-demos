<script setup lang="ts">
import { shallowRef } from 'vue';

/**
 * Events emitted by the task creation form.
 */
interface Emits {
  /**
   * Request creation of a task with a trimmed, non-empty title.
   */
  create: [title: string];
}

const emit = defineEmits<Emits>();
const title = shallowRef('');

/**
 * Emit a non-empty task title and reset the field for the next entry.
 *
 * Whitespace-only input is dropped here so the user is not shown a validation error for what is
 * almost always an accidental Enter press. The Worker performs the same trim-and-bound check
 * independently (see `src/worker/domain/todo-validation.ts`) — this is a convenience, not the
 * enforcement point.
 */
function submit(): void {
  const value = title.value.trim();
  if (value.length === 0) {
    return;
  }
  emit('create', value);
  title.value = '';
}
</script>

<template>
  <form class="todo-form" @submit.prevent="submit">
    <v-text-field
      v-model="title"
      aria-label="New task"
      autocomplete="off"
      class="todo-input"
      hide-details="auto"
      label="What needs doing?"
      maxlength="280"
      placeholder="Plan the next task"
      required
    />
    <v-btn color="primary" type="submit">Add task</v-btn>
  </form>
</template>

<style scoped>
.todo-form {
  align-items: start;
  display: flex;
  gap: 0.75rem;
}

.todo-input {
  flex: 1 1 auto;
}

@media (max-width: 600px) {
  .todo-form {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
