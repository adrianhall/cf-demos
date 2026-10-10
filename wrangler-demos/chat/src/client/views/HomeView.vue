<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChannelSidebar from "../components/ChannelSidebar.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import MessageComposer from "../components/MessageComposer.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import MessagePane from "../components/MessagePane.vue";
import { useChannelsStore } from "../stores/channels";
import { useRoomStore } from "../stores/room";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const channelsStore = useChannelsStore();
const room = useRoomStore();
const notice = shallowRef<string | null>(null);

/** @returns The channel to select by default: `general` if present, else the first channel. */
function pickDefaultChannel(): string | null {
  if (channelsStore.channels.length === 0) {
    return null;
  }
  const general = channelsStore.channels.find(
    (candidate) => candidate.name === "general",
  );
  return (general ?? channelsStore.channels[0]).name;
}

/** Connect to a channel selected from the sidebar, clearing any prior removal notice. */
function selectChannel(name: string): void {
  notice.value = null;
  room.connect(name);
}

/** Add a channel for every participant and immediately join it. */
async function createChannel(name: string): Promise<void> {
  notice.value = null;
  try {
    const created = await channelsStore.add(name);
    room.connect(created.name);
  } catch (cause) {
    notice.value =
      cause instanceof Error ? cause.message : "Could not add the channel.";
  }
}

/**
 * Remove a channel for every participant. If the browser was viewing the removed channel,
 * move it to a remaining one (or to the empty state if none remain).
 */
async function removeChannel(name: string): Promise<void> {
  notice.value = null;
  const wasSelected = room.channel === name;
  try {
    await channelsStore.remove(name);
    if (wasSelected) {
      const next = pickDefaultChannel();
      if (next !== null) {
        room.connect(next);
      } else {
        room.disconnect();
      }
    }
  } catch (cause) {
    notice.value =
      cause instanceof Error ? cause.message : "Could not remove the channel.";
  }
}

/** Send a message over the live connection, surfacing a failure without losing the draft. */
function sendMessage(body: string): void {
  try {
    room.send(body);
  } catch (cause) {
    notice.value =
      cause instanceof Error ? cause.message : "Could not send the message.";
  }
}

// A channel removed by any participant — including one removed by this browser's own action in
// a second window — closes every connected socket with the removal close code. This view is the
// single place that reacts to that: it re-reads the directory (the removal already deleted the
// D1 row) and hands the browser off to a remaining channel instead of leaving it on a dead one.
watch(
  () => room.status,
  async (status) => {
    if (status !== "removed") {
      return;
    }
    const removedName = room.channel;
    notice.value =
      removedName === null
        ? "This channel was removed."
        : `Channel "${removedName}" was removed.`;
    await channelsStore.load();
    const next = pickDefaultChannel();
    if (next !== null) {
      room.connect(next);
    } else {
      room.disconnect();
    }
  },
);

onMounted(async () => {
  await channelsStore.load();
  const initial = pickDefaultChannel();
  if (initial !== null) {
    room.connect(initial);
  }
});

// Close the live socket if this view is ever unmounted, so no connection outlives the page that
// opened it.
onUnmounted(() => room.disconnect());
</script>

<template>
  <div class="chat-workspace">
    <ChannelSidebar
      :channels="channelsStore.channels"
      :selected="room.channel"
      @create="createChannel"
      @remove="removeChannel"
      @select="selectChannel"
    />

    <section class="conversation" aria-label="Conversation">
      <v-alert
        v-if="notice"
        class="notice"
        closable
        density="compact"
        role="alert"
        type="info"
        variant="tonal"
        @click:close="notice = null"
      >
        {{ notice }}
      </v-alert>

      <template v-if="room.channel">
        <MessagePane
          :current-user-email="session.email"
          :messages="room.messages"
          :participants="room.participants"
          :status="room.status"
        />
        <MessageComposer
          :disabled="room.status !== 'connected'"
          @send="sendMessage"
        />
      </template>
      <p v-else class="empty-state">
        No channel selected. Add a channel in the sidebar to start a conversation.
      </p>
    </section>
  </div>
</template>

<style scoped>
.chat-workspace {
  display: flex;
  height: calc(100vh - 4rem);
}

.conversation {
  border-left: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.notice {
  margin: 0.75rem;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 2rem;
}

:deep(.channel-sidebar) {
  border-right: 1px solid rgb(var(--v-theme-outline-variant));
  flex: 0 0 16rem;
}

@media (max-width: 768px) {
  .chat-workspace {
    flex-direction: column;
    height: auto;
  }

  .conversation {
    border-left: none;
    min-height: 70vh;
  }

  :deep(.channel-sidebar) {
    border-right: none;
    border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
    flex: 0 0 auto;
    max-height: 16rem;
  }
}
</style>
