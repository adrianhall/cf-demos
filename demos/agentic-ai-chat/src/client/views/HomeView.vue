<script setup lang="ts">
import { watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatComposer from "../components/ChatComposer.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatTranscript from "../components/ChatTranscript.vue";
import { useChatStore } from "../stores/chat";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const chat = useChatStore();

// `session.load()` (App.vue) resolves asynchronously after this view mounts, so
// `session.isAuthenticated` is not yet `true` at mount time for the common case -- watch it
// instead of a one-time `onMounted` check, `immediate: true` covering the (rarer) case where a
// prior navigation already left the session authenticated.
watch(
  () => session.isAuthenticated,
  (isAuthenticated) => {
    if (isAuthenticated) {
      void chat.ensureChat();
    }
  },
  { immediate: true },
);
</script>

<template>
  <v-container class="home-view">
    <v-card v-if="session.error">
      <v-card-text>{{ session.error }}</v-card-text>
    </v-card>
    <template v-else-if="session.isAuthenticated">
      <v-card v-if="chat.initError">
        <v-card-text>{{ chat.initError }}</v-card-text>
      </v-card>
      <div v-else class="chat-panel">
        <ChatTranscript :turns="chat.turns" />
        <ChatComposer
          :disabled="chat.connectionStatus !== 'connected'"
          :is-streaming="chat.isStreaming"
          @send="chat.send"
        />
      </div>
    </template>
  </v-container>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 5rem);
  max-width: 56rem;
}

.chat-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}
</style>
