<script setup lang="ts">
import { computed, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatComposer from "../components/ChatComposer.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatSidebar from "../components/ChatSidebar.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatTranscript from "../components/ChatTranscript.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import RouteSelector from "../components/RouteSelector.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import UsageBadge from "../components/UsageBadge.vue";
import type { ChatRoute } from "../stores/chats";
import { useChatStore } from "../stores/chat";
import { useChatsStore } from "../stores/chats";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const chatsStore = useChatsStore();
const chat = useChatStore();

/** The currently open chat's own directory row (for its `route`), or `null` before any chat is
 * selected -- `useChatStore`'s live connection has no directory fields of its own (Section
 * 6.2a), so the route selector reads this store instead (docs/06-AGENTIC-CHAT.md Phase 4,
 * US-3). */
const selectedChat = computed(
  () =>
    chatsStore.chats.find((entry) => entry.id === chatsStore.selectedChatId) ??
    null,
);

/** Change the currently open chat's route (docs/06-AGENTIC-CHAT.md Phase 4, US-3). */
function onRouteChange(route: ChatRoute): void {
  if (chatsStore.selectedChatId) {
    void chatsStore.setRoute(chatsStore.selectedChatId, route);
  }
}

// `session.load()` (App.vue) resolves asynchronously after this view mounts, so
// `session.isAuthenticated` is not yet `true` at mount time for the common case -- watch it
// instead of a one-time `onMounted` check, `immediate: true` covering the (rarer) case where a
// prior navigation already left the session authenticated.
watch(
  () => session.isAuthenticated,
  (isAuthenticated) => {
    if (isAuthenticated) {
      void chatsStore.load();
    }
  },
  { immediate: true },
);

// Refresh the sidebar's directory listing (title, recency order) once `ChatAgent`'s own D1
// writes for this turn have actually landed -- signaled by its `chat_metadata_updated`
// broadcast (`chat-agent.ts`'s `afterTurnCompleted()`), not by the turn's own streaming status.
// The two are not the same moment: the AI SDK marks a turn "done" as soon as the model itself
// finishes generating, which is reliably *before* this data is ready (confirmed live -- see
// `afterTurnCompleted()`'s own JSDoc and docs/06-AGENTIC-CHAT.md Section 11) -- watching
// `isStreaming` here previously left the sidebar showing the previous title/order until an
// unrelated later reload happened to observe the finished write.
watch(
  () => chat.metadataUpdatedAt,
  () => {
    void chatsStore.load();
  },
);
</script>

<template>
  <v-container class="home-view" fluid>
    <v-card v-if="session.error">
      <v-card-text>{{ session.error }}</v-card-text>
    </v-card>
    <div v-else-if="session.isAuthenticated" class="chat-workspace">
      <ChatSidebar
        :chats="chatsStore.chats"
        :loading="chatsStore.loading"
        :selected-id="chatsStore.selectedChatId"
        @create="chatsStore.create"
        @remove="chatsStore.remove"
        @select="chatsStore.select"
      />

      <section class="conversation" aria-label="Conversation">
        <p v-if="chatsStore.error" class="notice notice-error" role="alert">
          {{ chatsStore.error }}
        </p>
        <p
          v-if="chat.connectionStatus === 'removed'"
          class="notice"
          role="status"
        >
          This chat was removed.
        </p>

        <template
          v-if="chatsStore.selectedChatId && chat.connectionStatus !== 'removed'"
        >
          <div v-if="selectedChat" class="conversation-header">
            <UsageBadge
              :last-reconciliation-event="chat.lastReconciliationEvent"
              :usage="chat.usage"
            />
            <RouteSelector
              :disabled="chat.turns.length > 0"
              :route="selectedChat.route"
              @change="onRouteChange"
            />
          </div>
          <ChatTranscript :turns="chat.turns" />
          <ChatComposer
            :disabled="chat.connectionStatus !== 'connected'"
            :is-streaming="chat.isStreaming"
            @send="chat.send"
          />
        </template>
        <p v-else-if="chat.connectionStatus !== 'removed'" class="empty-state">
          No chat selected. Start a new one from the sidebar.
        </p>
      </section>
    </div>
  </v-container>
</template>

<style scoped>
.home-view {
  height: calc(100vh - 5rem);
  max-width: 72rem;
  padding: 0;
}

.chat-workspace {
  display: flex;
  height: 100%;
}

.conversation {
  border-left: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.notice {
  margin: 0.75rem 1rem 0;
}

.conversation-header {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: space-between;
  padding: 0.75rem 1rem;
}

.notice-error {
  color: #b3261e;
  font-weight: 600;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 2rem;
}

:deep(.chat-sidebar) {
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

  :deep(.chat-sidebar) {
    border-right: none;
    border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
    flex: 0 0 auto;
    max-height: 16rem;
  }
}
</style>
