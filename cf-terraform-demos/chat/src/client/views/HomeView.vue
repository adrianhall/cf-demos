<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, watch } from 'vue';
import ChannelSidebar from '../components/ChannelSidebar.vue';
import MessageComposer from '../components/MessageComposer.vue';
import MessagePane from '../components/MessagePane.vue';
import { useChannelsStore } from '../stores/channels';
import { useRoomStore } from '../stores/room';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const channels = useChannelsStore();
const room = useRoomStore();
const notice = shallowRef<string | null>(null);

/**
 * Choose which channel to show when no specific one is requested.
 *
 * Prefers `general` — seeded by the migration and the conventional default in a chat workspace —
 * and otherwise falls back to the first channel in the directory's name order.
 *
 * @returns A channel name, or `null` when the workspace has no channels at all.
 */
function defaultChannel(): string | null {
  const general = channels.channels.find((candidate) => candidate.name === 'general');
  return (general ?? channels.channels[0])?.name ?? null;
}

/**
 * Connect to the best available channel, or disconnect when there is none left.
 *
 * Used after anything that may have removed the channel being viewed, so the workspace never sits
 * on a channel that no longer exists.
 */
function showDefaultChannel(): void {
  const next = defaultChannel();
  if (next === null) {
    room.disconnect();
  } else {
    room.connect(next);
  }
}

/**
 * Show a user-safe failure message.
 *
 * @param cause Value thrown by a store action.
 * @param fallback Message to show when `cause` carries nothing displayable.
 */
function showError(cause: unknown, fallback: string): void {
  notice.value = cause instanceof Error ? cause.message : fallback;
}

/**
 * Connect to a channel chosen in the sidebar.
 *
 * @param name Channel to join.
 */
function selectChannel(name: string): void {
  notice.value = null;
  room.connect(name);
}

/**
 * Create a channel and immediately join it.
 *
 * Joining straight away is deliberate: a participant who just named a channel wants to talk in it,
 * and the store returns the server's normalized name so the channel joined is the one that was
 * actually created rather than the text that was typed.
 *
 * @param name Candidate channel name entered in the sidebar.
 * @returns A promise fulfilled once the channel is created and joined, or a failure is shown.
 */
async function createChannel(name: string): Promise<void> {
  notice.value = null;
  try {
    const created = await channels.create(name);
    room.connect(created.name);
  } catch (cause) {
    showError(cause, 'Could not add the channel.');
  }
}

/**
 * Remove a channel and move on if it was the one being viewed.
 *
 * The check runs before the removal, because the room store clears `channel` as part of
 * disconnecting and reading it afterwards would always say `null`.
 *
 * @param name Channel to remove.
 * @returns A promise fulfilled once the channel is removed and the view has moved, or a failure is
 *   shown.
 */
async function removeChannel(name: string): Promise<void> {
  notice.value = null;
  const wasViewing = room.channel === name;
  try {
    await channels.remove(name);
    if (wasViewing) {
      showDefaultChannel();
    }
  } catch (cause) {
    showError(cause, 'Could not remove the channel.');
  }
}

/**
 * Send a message on the live connection.
 *
 * Failures are surfaced as a notice rather than thrown, so a send attempted during a reconnect
 * explains itself instead of producing an unhandled rejection.
 *
 * @param body Message text entered in the composer.
 */
function sendMessage(body: string): void {
  try {
    room.send(body);
  } catch (cause) {
    showError(cause, 'Could not send the message.');
  }
}

/**
 * React to a channel being removed by anybody — including by this browser in another window.
 *
 * The room store reports the removal by moving to `removed`; this view is the single place that
 * decides what to do about it, because recovering means re-reading the directory and choosing a
 * different channel, and neither of those is the room store's concern. Handling it here rather than
 * in `removeChannel` is what makes a removal performed by _another_ participant behave identically
 * to one performed locally.
 */
watch(
  () => room.status,
  async (status) => {
    if (status !== 'removed') {
      return;
    }
    const removed = room.channel;
    notice.value =
      removed === null ? 'This channel was removed.' : `Channel "${removed}" was removed.`;
    await channels.load();
    showDefaultChannel();
  }
);

/**
 * Load the directory and join a channel when the view is first displayed.
 */
onMounted(async () => {
  await channels.load();
  if (channels.error !== null) {
    notice.value = channels.error;
  }
  showDefaultChannel();
});

/**
 * Close the connection when the view goes away, so no socket outlives the page that opened it.
 */
onUnmounted(() => room.disconnect());
</script>

<template>
  <div class="chat-workspace">
    <ChannelSidebar
      class="sidebar"
      :channels="channels.channels"
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
      <v-alert
        v-if="room.error"
        class="notice"
        density="compact"
        role="alert"
        type="warning"
        variant="tonal"
      >
        {{ room.error }}
      </v-alert>

      <v-progress-circular
        v-if="channels.loading"
        aria-label="Loading channels"
        class="loading"
        indeterminate
      />
      <template v-else-if="room.channel">
        <MessagePane
          :current-user-email="session.email"
          :messages="room.messages"
          :participants="room.participants"
          :status="room.status"
        />
        <MessageComposer :can-send="room.canSend" @send="sendMessage" />
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
  /* The header is a fixed 4rem, so the workspace fills exactly the rest of the viewport. That
     lets the message list own its own scrolling instead of the page scrolling as a whole, which
     is what keeps the composer visible while reading back through history. */
  height: calc(100vh - 4rem);
}

.sidebar {
  border-right: 1px solid rgb(var(--v-theme-outline-variant));
  flex: 0 0 16rem;
}

.conversation {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.notice {
  margin: 0.75rem;
}

.loading {
  display: block;
  margin: 2rem auto;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 2rem;
}

@media (max-width: 768px) {
  .chat-workspace {
    flex-direction: column;
    height: auto;
  }

  .sidebar {
    border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
    border-right: none;
    flex: 0 0 auto;
    max-height: 16rem;
  }

  .conversation {
    min-height: 70vh;
  }
}
</style>
