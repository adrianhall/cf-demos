<script setup lang="ts">
/**
 * Route-level composition for Chat.
 *
 * The feature has two deliberate modes. Before the first message, a centred welcome prompt and
 * composer give the visitor one obvious place to begin. Once a message is sent, the transcript owns
 * the page and the composer becomes a sticky control at the bottom, matching the interaction
 * pattern people already know from ChatGPT, Gemini, and Cloudflare OS.
 *
 * Presentation is split into focused feature components; this view owns only catalogue wiring,
 * modal state, and the scroll side effect that follows a streaming answer.
 */
import { computed, nextTick, onMounted, shallowRef, useTemplateRef, watch } from 'vue';
import { findTask } from '../../tasks';
import InfoDialog from '../components/InfoDialog.vue';
import PanelPage from '../components/PanelPage.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import ChatComposer from '../features/chat/ChatComposer.vue';
import ChatTranscript from '../features/chat/ChatTranscript.vue';
import ChatWelcome from '../features/chat/ChatWelcome.vue';
import { type ChatExample } from '../features/chat/examples';
import { useChat } from '../features/chat/useChat';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('chat'));
const catalogue = useCatalogueStore();

const {
  turns,
  draft,
  model,
  temperature,
  streaming,
  error,
  receipt,
  metrics,
  costPending,
  canSend,
  send,
  cancel,
  reset
} = useChat({ initialModel: '' });

/**
 * Whether the optional temperature control is visible inside the composer.
 */
const showSampling = shallowRef(false);

/**
 * Whether details for the latest completed answer are open.
 */
const showRunDetails = shallowRef(false);

/**
 * Whether Chat has left its welcome state.
 */
const hasConversation = computed(() => turns.value.length > 0);

/**
 * Reviewed models available for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('chat'));

/**
 * Descriptor for the model the next message will use.
 */
const selectedModel = computed(() => models.value.find((entry) => entry.id === model.value));

/**
 * Invisible anchor at the end of the transcript.
 *
 * A plain element reference rather than a child-component imperative API: scrolling is a layout
 * side effect owned by this route composition, while the transcript remains a props-only renderer.
 */
const conversationEnd = shallowRef<HTMLElement | null>(null);

/**
 * Composer in whichever of the two layouts is currently mounted.
 *
 * Both conditional instances share this template-ref name. Only one exists at a time, and its
 * exposed `focus()` method is the deliberate landing point when one layout replaces the other.
 */
const composer = useTemplateRef<InstanceType<typeof ChatComposer>>('composer');

onMounted(async () => {
  await catalogue.load();
  const first = models.value[0];
  if (model.value === '' && first !== undefined) {
    model.value = first.id;
  }
});

/**
 * Loads a prepared question without sending it.
 *
 * @param example Suggested question to load.
 * @returns Nothing; spending credit remains an explicit Send action.
 */
function loadExample(example: ChatExample): void {
  draft.value = example.prompt;
}

// Both Send and New chat replace the layout that contains the focused control. Move focus into the
// replacement composer after the patch, so a keyboard user continues where they were instead of
// being dropped at the top of the document and traversing the whole sidebar again.
watch(hasConversation, async () => {
  await nextTick();
  composer.value?.focus();
});

// Follow the newest turn only while the visitor is already near the page bottom. A visitor who has
// scrolled up to reread an earlier answer keeps their place, and `auto` avoids animated motion on
// every stream delta (including for visitors who request reduced motion).
watch(
  () => turns.value.map((turn) => `${turn.id}:${turn.content.length}:${turn.streaming}`).join('|'),
  async () => {
    if (!hasConversation.value) {
      return;
    }

    const distanceFromBottom =
      document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
    if (distanceFromBottom > 160) {
      return;
    }

    await nextTick();
    conversationEnd.value?.scrollIntoView?.({ behavior: 'auto', block: 'end' });
  }
);

/**
 * Starts a new conversation and returns the optional UI to its quiet default.
 *
 * @returns Nothing.
 */
function startNewConversation(): void {
  reset();
  showSampling.value = false;
  showRunDetails.value = false;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        prompt and the answer are logged too: treat this as you would any shared AI service and do
        not enter anything confidential.
      </p>
      <p class="about-model">
        A model bills by the token, not by the word.
        <router-link to="/view-tokens">View Tokens</router-link>
        shows how a message is split up in your browser at no cost.
        <span v-if="selectedModel?.contextWindowTokens">
          {{ selectedModel.name }} has a
          {{ selectedModel.contextWindowTokens.toLocaleString() }}-token context window.
        </span>
      </p>
      <p v-if="selectedModel" class="about-model-link">
        <a :href="selectedModel.documentationUrl" rel="noreferrer" target="_blank">
          {{ selectedModel.name }} in the model catalog
        </a>
      </p>
    </template>

    <div class="chat" :class="{ 'chat--active': hasConversation }">
      <template v-if="!hasConversation">
        <div class="welcome-layout">
          <ChatWelcome @choose="loadExample" />
          <ChatComposer
            ref="composer"
            v-model:draft="draft"
            v-model:model="model"
            v-model:temperature="temperature"
            :models="models"
            :can-send="canSend"
            :streaming="streaming"
            :has-conversation="false"
            :has-run-details="false"
            :show-sampling="showSampling"
            @submit="send"
            @cancel="cancel"
            @reset="startNewConversation"
            @show-run-details="showRunDetails = true"
            @toggle-sampling="showSampling = !showSampling"
          />
          <p v-if="error" class="error" role="alert">{{ error }}</p>
        </div>
      </template>

      <template v-else>
        <div class="conversation-layout">
          <div class="conversation-scroll">
            <ChatTranscript :turns="turns" />
            <p v-if="error" class="error" role="alert">{{ error }}</p>
            <div ref="conversationEnd" class="conversation-end" aria-hidden="true"></div>
          </div>

          <!--
            Sticky inside the chat workspace rather than fixed to the viewport. It remains at the
            bottom while the page scrolls, without covering the application sidebar or escaping the
            routed panel's width.
          -->
          <div class="composer-dock">
            <ChatComposer
              ref="composer"
              v-model:draft="draft"
              v-model:model="model"
              v-model:temperature="temperature"
              :models="models"
              :can-send="canSend"
              :streaming="streaming"
              :has-conversation="true"
              :has-run-details="receipt !== undefined"
              :show-sampling="showSampling"
              @submit="send"
              @cancel="cancel"
              @reset="startNewConversation"
              @show-run-details="showRunDetails = true"
              @toggle-sampling="showSampling = !showSampling"
            />
          </div>
        </div>
      </template>

      <InfoDialog :open="showRunDetails" title="Run details" @close="showRunDetails = false">
        <RunDetails
          v-if="receipt"
          embedded
          :receipt="receipt"
          :metrics="metrics"
          :cost-pending="costPending"
        />
      </InfoDialog>
    </div>
  </PanelPage>
</template>

<style scoped>
/* Inside the description modal, which supplies its own padding and background. */
.attribution {
  margin: 1rem 0 0;
}

.about-model,
.about-model-link {
  margin: 0.75rem 0 0;
}

.chat {
  margin: 0 auto;
  max-width: 54rem;
  min-width: 0;
}

.welcome-layout {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  justify-content: center;
  min-height: calc(100vh - 13rem);
}

.conversation-layout {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 8rem);
}

.conversation-scroll {
  flex: 1 1 auto;
  padding: 0.5rem 0 1.5rem;
}

.conversation-end {
  height: 1px;
}

.composer-dock {
  background: linear-gradient(
    to bottom,
    rgb(var(--v-theme-background) / 0%),
    rgb(var(--v-theme-background)) 1.5rem
  );
  bottom: 0;
  padding: 1.5rem 0 0.75rem;
  position: sticky;
  z-index: 5;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
  text-align: center;
}

@media (max-width: 40rem) {
  .welcome-layout {
    justify-content: flex-start;
    min-height: auto;
    padding-top: 1rem;
  }

  .conversation-layout {
    min-height: calc(100vh - 6rem);
  }
}

/*
  Leave enough room when the browser scrolls a focused transcript link into view, so the sticky
  composer cannot cover it at the bottom edge.
*/
:global(#main-content) {
  scroll-padding-bottom: 12rem;
}
</style>
