<script setup lang="ts">
import { shallowRef } from 'vue';
import type { Channel } from '../stores/channels';

/**
 * Properties supplied to the channel sidebar.
 */
interface Props {
  /**
   * The shared channel directory, name-ordered.
   */
  channels: Channel[];
  /**
   * Currently connected channel, or `null` when none is selected.
   */
  selected: string | null;
}

/**
 * Events emitted by the channel sidebar.
 */
interface Emits {
  /**
   * Request that the browser connect to a different channel.
   */
  select: [name: string];
  /**
   * Request creation of a channel from a candidate, not-yet-normalized name.
   */
  create: [name: string];
  /**
   * Request removal of a channel, along with everything said in it.
   */
  remove: [name: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
const draftName = shallowRef('');

/**
 * Emit a non-empty candidate channel name and reset the field for the next one.
 *
 * Whitespace-only input is dropped here so the participant is not shown a validation error for what
 * is almost always an accidental Enter press. The name is emitted as typed rather than normalized
 * locally: the Worker owns normalization (see `src/worker/domain/channel-validation.ts`), and
 * duplicating the rules here would create a second definition to keep in sync.
 */
function submitCreate(): void {
  const value = draftName.value.trim();
  if (value.length === 0) {
    return;
  }
  emit('create', value);
  draftName.value = '';
}
</script>

<template>
  <nav class="channel-sidebar" aria-label="Channels">
    <h2 class="sidebar-heading">Channels</h2>

    <v-list
      v-if="channels.length > 0"
      aria-label="Channel list"
      class="channel-list"
      density="compact"
      lines="one"
    >
      <v-list-item
        v-for="item in channels"
        :key="item.name"
        :active="item.name === selected"
        :aria-current="item.name === selected ? 'true' : undefined"
        class="channel-item"
        @click="emit('select', item.name)"
      >
        <v-list-item-title>
          <span aria-hidden="true" class="channel-sigil">#</span>{{ item.name }}
        </v-list-item-title>
        <template #append>
          <!--
            `@click.stop` keeps the removal from also selecting the channel it just removed,
            since the button sits inside the clickable list item.
          -->
          <v-btn
            :aria-label="`Remove channel: ${item.name}`"
            class="remove-button"
            density="comfortable"
            icon
            size="small"
            variant="text"
            @click.stop="emit('remove', item.name)"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path
                d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"
              />
            </svg>
          </v-btn>
        </template>
      </v-list-item>
    </v-list>
    <p v-else class="empty-state">No channels yet. Add one below to start a conversation.</p>

    <form class="add-channel-form" @submit.prevent="submitCreate">
      <v-text-field
        v-model="draftName"
        aria-label="New channel name"
        autocomplete="off"
        density="compact"
        hide-details="auto"
        hint="Lowercase letters, digits, and hyphens"
        label="Add channel"
        maxlength="32"
        placeholder="deploys"
      />
      <v-btn color="primary" type="submit" variant="tonal">Add</v-btn>
    </form>
  </nav>
</template>

<style scoped>
.channel-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  padding: 1rem;
}

.sidebar-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.channel-list {
  background: transparent;
  flex: 1 1 auto;
  overflow-y: auto;
}

.channel-sigil {
  color: rgb(var(--v-theme-on-surface-variant));
  margin-inline-end: 0.25rem;
}

.channel-item {
  min-height: 2.75rem;
}

.remove-button {
  opacity: 0.6;
}

.remove-button:hover,
.remove-button:focus-visible {
  opacity: 1;
}

.remove-button svg {
  block-size: 1.125rem;
  fill: currentcolor;
  inline-size: 1.125rem;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  flex: 1 1 auto;
  font-size: 0.875rem;
}

.add-channel-form {
  align-items: start;
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 0.5rem;
  padding-top: 0.75rem;
}

.add-channel-form .v-text-field {
  flex: 1 1 auto;
}
</style>
