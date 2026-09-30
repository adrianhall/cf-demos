<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from 'vue';
import type { ChatMessage } from '../../chat-protocol';
import type { RoomStatus } from '../stores/room';

/**
 * Properties supplied to the message pane.
 */
interface Props {
  /**
   * Replayed history plus every message broadcast since connecting, oldest first.
   */
  messages: ChatMessage[];
  /**
   * Number of participants currently connected to this channel.
   */
  participants: number;
  /**
   * Connection lifecycle, used to explain a gap in delivery rather than leaving the pane looking
   * simply quiet.
   */
  status: RoomStatus;
  /**
   * The reader's own verified identity, used to distinguish their messages from everybody else's.
   * Presentation only — authorship is decided server-side.
   */
  currentUserEmail: string | null;
}

const props = defineProps<Props>();
const scrollRegion = useTemplateRef<HTMLDivElement>('scroll-region');

/**
 * Format a timestamp for display beside a message author.
 *
 * Rendered in the reader's own locale and timezone rather than the server's, because the stored
 * value is an absolute instant and "when was this said" only means something relative to the person
 * reading it.
 *
 * @param iso ISO-8601 timestamp recorded when the message was persisted.
 * @returns A short local time such as `14:32`.
 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Keep the newest message in view as history replays and new messages arrive.
 *
 * Watches the message _count_ rather than the array itself: the array is replaced wholesale on
 * every history replay, and watching it deeply would re-run on changes that do not add anything to
 * scroll to. `nextTick` waits for Vue to render the new message, since scrolling to a height the
 * DOM does not have yet would do nothing.
 */
watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    const region = scrollRegion.value;
    if (region !== null) {
      region.scrollTop = region.scrollHeight;
    }
  }
);
</script>

<template>
  <section class="message-pane" aria-labelledby="message-pane-heading">
    <header class="message-pane-header">
      <h2 id="message-pane-heading" class="sr-only">Channel messages</h2>
      <p class="participant-count" role="status">
        {{ participants }} {{ participants === 1 ? 'participant' : 'participants' }}
      </p>
      <p v-if="status === 'connecting'" class="connection-notice" role="status">Connecting…</p>
      <p v-else-if="status === 'reconnecting'" class="connection-notice" role="status">
        Connection lost — retrying…
      </p>
    </header>

    <!--
      `role="log"` with `aria-live="polite"` announces newly appended messages to a screen reader
      without interrupting whatever it is currently reading, which is the correct politeness for
      an ongoing conversation.
    -->
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
          <time class="message-time" :datetime="message.createdAt">
            {{ formatTime(message.createdAt) }}
          </time>
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
  min-height: 0;
  flex: 1 1 auto;
}

.message-pane-header {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  padding: 0.75rem 1rem;
}

.participant-count {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}

.connection-notice {
  color: rgb(var(--v-theme-primary));
  font-size: 0.8125rem;
  font-weight: 600;
}

.message-scroll {
  flex: 1 1 auto;
  min-height: 0;
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
  overflow-wrap: anywhere;
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
  /* Preserves the line breaks a participant typed; the domain already rejects control
     characters, so the only whitespace reaching here is ordinary. */
  white-space: pre-wrap;
}

.message.own .message-body {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

/* Keeps the pane's accessible heading available to screen readers without showing it visually. */
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
