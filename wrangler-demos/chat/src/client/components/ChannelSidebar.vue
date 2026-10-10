<script setup lang="ts">
import { shallowRef } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import type { Channel } from "../stores/channels";

/** Properties supplied to the channel sidebar. */
interface Props {
  /** The shared, D1-backed channel directory. */
  channels: Channel[];
  /** The currently connected channel name, or `null` before any channel is selected. */
  selected: string | null;
}

/** Events emitted by the channel sidebar. */
interface Emits {
  /** Request that the browser connect to a different channel's Durable Object. */
  select: [name: string];
  /** Request creation of a new channel with a candidate, not-yet-normalized name. */
  create: [name: string];
  /** Request removal of an existing channel, available to every participant. */
  remove: [name: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
const draftName = shallowRef("");

/** Submit a non-empty candidate channel name and reset the field for the next one. */
function submitCreate(): void {
  const value = draftName.value.trim();
  if (value.length === 0) {
    return;
  }
  emit("create", value);
  draftName.value = "";
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
        <template #prepend>
          <FeatherIcon aria-hidden="true" size="16" type="hash" />
        </template>
        <v-list-item-title>{{ item.name }}</v-list-item-title>
        <template #append>
          <v-btn
            :aria-label="`Remove channel: ${item.name}`"
            class="remove-button"
            density="compact"
            icon
            size="small"
            variant="text"
            @click.stop="emit('remove', item.name)"
          >
            <FeatherIcon aria-hidden="true" size="16" type="x" />
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
        label="Add channel"
        maxlength="32"
        placeholder="deploys"
      />
      <v-btn color="primary" type="submit" variant="tonal">
        <FeatherIcon aria-hidden="true" size="16" type="plus" />
        <span class="ml-2">Add</span>
      </v-btn>
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
  font-size: 0.9375rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--v-theme-on-surface-variant));
}

.channel-list {
  flex: 1 1 auto;
  overflow-y: auto;
}

.channel-item :deep(.v-list-item__prepend) {
  margin-inline-end: 0.5rem;
}

.remove-button {
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
