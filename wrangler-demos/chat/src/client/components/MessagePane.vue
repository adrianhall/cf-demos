<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import type { ChatMessage } from "../../chat-protocol";
import type { RoomStatus } from "../stores/room";

/** Properties supplied to the message pane. */
interface Props {
  /** Replayed history plus every message broadcast since connecting. */
  messages: ChatMessage[];
  /** Current connected-participant count for the selected channel. */
  participants: number;
  /** WebSocket connection lifecycle, used to show a connecting/reconnecting banner. */
  status: RoomStatus;
  /** The signed-in participant's own verified email, used to highlight their own messages. */
  currentUserEmail: string | null;
}

const props = defineProps<Props>();
const scrollRegion = useTemplateRef<HTMLDivElement>("scroll-region");

/** Format an ISO 8601 timestamp for display next to a message's author. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Keep the newest message in view as history replays or new messages arrive. */
watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    const region = scrollRegion.value;
    if (region !== null) {
      region.scrollTop = region.scrollHeight;
    }
  },
);
</script>

<template>
  <section class="message-pane" aria-labelledby="message-pane-heading">
    <header class="message-pane-header">
      <h2 id="message-pane-heading" class="sr-only">Channel messages</h2>
      <p class="participant-count" role="status">
        <FeatherIcon aria-hidden="true" size="16" type="users" />
        {{ participants }} {{ participants === 1 ? "participant" : "participants" }}
      </p>
      <p v-if="status === 'connecting'" class="connection-notice" role="status">Connecting…</p>
      <p v-else-if="status === 'reconnecting'" class="connection-notice" role="status">
        Reconnected dropped — retrying…
      </p>
    </header>

    <div ref="scroll-region" class="message-scroll" role="log" aria-live="polite">
      <p v-if="messages.length === 0" class="empty-state">
        No messages yet. Be the first to say something.
      </p>
      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="{ own: message.author === currentUserEmail }"
      >
        <p class="message-meta">
          <span class="message-author">{{ message.author }}</span>
          <time class="message-time" :datetime="message.createdAt">{{ formatTime(message.createdAt) }}</time>
        </p>
        <p class="message-body">{{ message.body }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.message-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.message-pane-header {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  padding: 0.75rem 1rem;
}

.participant-count {
  align-items: center;
  color: rgb(var(--v-theme-on-surface-variant));
  display: flex;
  font-size: 0.875rem;
  gap: 0.375rem;
}

.connection-notice {
  color: rgb(var(--v-theme-primary));
  font-size: 0.8125rem;
  font-weight: 600;
}

.message-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 1rem;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}

.message {
  margin-bottom: 0.75rem;
  max-width: 34rem;
}

.message.own {
  margin-inline-start: auto;
}

.message-meta {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
}

.message-author {
  color: rgb(var(--v-theme-primary));
  font-size: 0.8125rem;
  font-weight: 700;
}

.message-time {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.message-body {
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface));
  margin-top: 0.25rem;
  overflow-wrap: anywhere;
  padding: 0.5rem 0.75rem;
  white-space: pre-wrap;
}

.message.own .message-body {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
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
</style>
