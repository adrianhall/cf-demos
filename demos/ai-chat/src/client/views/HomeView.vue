<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatComposer from "../components/ChatComposer.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ChatTranscript from "../components/ChatTranscript.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ExportButton from "../components/ExportButton.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ModelSelector from "../components/ModelSelector.vue";
import { useChatStore } from "../stores/chat";
import { useSettingsStore } from "../stores/settings";

/**
 * The AI Model Playground's single view: model/parameter selection, the streaming transcript,
 * the composer, and Export — see docs/05-AI-CHAT.md, Phase 4. There is deliberately only one
 * route; the conversation lives entirely in {@link useChatStore}, never on the server.
 */
const settings = useSettingsStore();
const chat = useChatStore();

/**
 * Reload the page so the browser re-navigates through Cloudflare Access's normal sign-in flow
 * after a lapsed session (see docs/05-AI-CHAT.md, Access Model). Defined here rather than
 * inlined in the template: Vue's template expression sandbox does not expose the bare `window`
 * global, so `window.location.reload()` written directly in a template resolves to `undefined`.
 */
function reload(): void {
  window.location.reload();
}
</script>

<template>
  <div class="playground">
    <ModelSelector
      class="sidebar"
      :max-tokens="settings.maxTokens"
      :model-id="settings.modelId"
      :temperature="settings.temperature"
      @update:max-tokens="settings.setMaxTokens"
      @update:model-id="settings.selectModel"
      @update:temperature="settings.setTemperature"
    />

    <section class="conversation" aria-label="Conversation">
      <div
        v-if="chat.sessionExpired"
        class="session-expired"
        role="alert"
      >
        <p>Your session expired. Sign in again to continue the conversation.</p>
        <button type="button" @click="reload">Reload</button>
      </div>

      <div class="conversation-toolbar">
        <ExportButton :turns="chat.turns" />
      </div>

      <!-- Announces only the newest streamed delta, never the accumulated transcript, so a
           screen reader isn't forced to re-read the whole answer on every token (see
           docs/05-AI-CHAT.md, Phase 4, task 19's accessibility requirements). -->
      <div class="sr-only" aria-live="polite" role="status">{{ chat.lastDelta }}</div>

      <ChatTranscript :turns="chat.turns" />

      <ChatComposer
        :is-streaming="chat.isStreaming"
        @send="chat.submit"
        @stop="chat.stop"
      />
    </section>
  </div>
</template>

<style scoped>
.playground {
  display: flex;
  height: calc(100vh - 4rem);
}

.sidebar {
  flex: 0 0 18rem;
  margin: 1rem;
}

.conversation {
  border-left: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.conversation-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 0.75rem 1rem 0;
}

.session-expired {
  align-items: center;
  background: #fdecea;
  color: #b3261e;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  margin: 0.75rem 1rem 0;
  padding: 0.75rem 1rem;
}

.session-expired button {
  background: #b3261e;
  border: none;
  border-radius: 0.375rem;
  color: #ffffff;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  min-height: 2.5rem;
  padding: 0 1rem;
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

@media (max-width: 768px) {
  .playground {
    flex-direction: column;
    height: auto;
  }

  .sidebar {
    flex: 0 0 auto;
    margin: 1rem;
  }

  .conversation {
    border-left: none;
    min-height: 70vh;
  }
}
</style>
