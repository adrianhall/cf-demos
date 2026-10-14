<script setup lang="ts">
/**
 * The chat panel: the right-hand drawer that composes the transcript and the composer over one chat
 * session.
 *
 * This is the composition surface for the feature. It owns the session (through `useCrmChat`), the
 * drawer's responsive behaviour, and the keyboard contract; the transcript, the message, the
 * approval card, and the composer own their own presentation.
 *
 * **Responsive on purpose.** Below the `md` breakpoint the drawer is `temporary`, so it overlays
 * and traps focus the way a phone's sheet should; above it the drawer is `permanent`, so the record
 * under discussion stays visible beside the conversation. Vuetify provides both behaviours,
 * including the focus trap, so the panel does not reimplement either.
 *
 * `Esc` closes the panel and focus returns to the Chat button in the app bar, which is where the
 * user was before they opened it (WCAG 2.4.3). The button, not an arbitrary element: the panel is
 * opened from a toggle, so that toggle is the only sensible place to come back to.
 *
 * @fires close The panel asked to be closed, so the shell can return focus to its toggle.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useDisplay } from 'vuetify';
import { mdiBroom, mdiClose } from '@mdi/js';
import { CHAT_CONTEXT_ROUTES, type ChatPageContext } from '../../../shared/api/chat.ts';
import { useCrmChat } from '../../composables/useCrmChat.ts';
import ChatComposer from './ChatComposer.vue';
import ChatTranscript from './ChatTranscript.vue';

const emit = defineEmits<{
  /**
   * The user closed the panel.
   */
  close: [];
}>();

const route = useRoute();
const { mdAndUp } = useDisplay();

/**
 * The record the user is looking at, derived from the current route.
 *
 * Only record routes qualify, and only with a well-formed identifier, because the hint is sent to
 * the server where the same strict schema validates it again. A list page has no "this record", so
 * it sends nothing rather than something vague.
 */
function pageContext(): ChatPageContext | undefined {
  const name = typeof route.name === 'string' ? route.name : '';
  const id = typeof route.params.id === 'string' ? route.params.id : '';
  const matched = CHAT_CONTEXT_ROUTES.find((candidate) => candidate === name);
  return matched === undefined || id === '' ? undefined : { route: matched, id };
}

const chat = useCrmChat({ pageContext });

/**
 * Whether the connection error is still visible. Keeping this local lets the user dismiss a
 * provider/billing alert without pretending the underlying chat connection recovered.
 */
const showError = ref(true);

watch(
  () => chat.error.value,
  (message) => {
    showError.value = message !== null;
  },
  { immediate: true }
);

/**
 * Dismiss the current error notice. A later failure or a fresh turn makes it visible again.
 *
 * @returns Nothing.
 */
function dismissError(): void {
  showError.value = false;
}

/**
 * Whether a turn is in progress.
 */
const busy = computed(() => chat.status.value === 'submitted' || chat.status.value === 'streaming');

/**
 * Whether the panel is waiting for the model's first output of a turn.
 */
const pending = computed(() => chat.status.value === 'submitted');

/**
 * Close the panel when Escape is pressed anywhere in it or in the page behind it. A `permanent`
 * drawer has no scrim to dismiss, so this is the only closing gesture a keyboard user has besides
 * the close button.
 *
 * @param event The keyboard event.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <v-navigation-drawer
    id="chat-panel"
    location="right"
    :permanent="mdAndUp"
    :temporary="!mdAndUp"
    :model-value="true"
    width="420"
    aria-label="Assistant"
    data-testid="chat-panel"
  >
    <div class="chat-layout">
      <v-toolbar density="comfortable" color="surface">
        <v-toolbar-title class="text-subtitle-1">
          <h2 class="text-subtitle-1 ma-0">Assistant</h2>
        </v-toolbar-title>
        <v-btn
          variant="text"
          :icon="mdiBroom"
          aria-label="Clear chat"
          data-testid="chat-clear"
          @click="chat.clear()"
        />
        <v-btn
          variant="text"
          :icon="mdiClose"
          aria-label="Close assistant"
          data-testid="chat-close"
          @click="emit('close')"
        />
      </v-toolbar>

      <v-alert
        v-if="showError && chat.error.value !== null"
        type="error"
        variant="tonal"
        role="alert"
        density="compact"
        closable
        class="chat-error ma-2"
        data-testid="chat-error"
        data-error-kind="assistant-failure"
        @click:close="dismissError"
        >{{ chat.error.value }}</v-alert
      >
      <v-progress-linear
        v-else-if="chat.connection.value === 'connecting'"
        indeterminate
        aria-label="Connecting to the assistant"
        data-testid="chat-connecting"
      />

      <ChatTranscript
        :messages="chat.messages.value"
        :expired="chat.expired.value"
        :pending="pending"
        @decide="chat.decide"
      />

      <v-divider />
      <ChatComposer
        :disabled="chat.connection.value !== 'ready'"
        :busy="busy"
        @send="chat.send"
        @stop="chat.stop"
      />
    </div>
  </v-navigation-drawer>
</template>

<style scoped>
.chat-error {
  flex: 0 0 auto;
  max-height: 96px;
  overflow-y: auto;
}

.chat-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
</style>
