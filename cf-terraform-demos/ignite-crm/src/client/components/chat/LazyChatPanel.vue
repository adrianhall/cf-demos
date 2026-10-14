<script setup lang="ts">
/**
 * The chat panel's loading boundary.
 *
 * The panel pulls in the Agents client, the AI SDK's chat pieces, and (through `MarkdownView`) the
 * Markdown renderer. A user who never opens chat should not download any of it, so the real panel
 * is a `defineAsyncComponent` and this component is what the shell mounts
 * (`specs/ignite-crm/05-ai-features.md` §6.3). `check:bundles` reports the resulting chunk.
 *
 * While the chunk downloads the drawer shows a labelled progress bar rather than nothing, and a
 * chunk that cannot be fetched — typically after a deployment replaced the hashed files — gets the
 * same explain-and-reload treatment the rest of the SPA uses, instead of an empty panel.
 *
 * @fires close The panel asked to be closed.
 */
import { defineAsyncComponent, ref } from 'vue';

const emit = defineEmits<{
  /**
   * The user closed the panel.
   */
  close: [];
}>();

const failed = ref(false);

/**
 * The real panel, in its own chunk.
 *
 * The failure is caught in the **loader** rather than in `onError`: `onError`'s `fail()` re-rejects
 * the load, and `Suspense` has nobody to hand that rejection to, so it surfaces as an unhandled
 * promise rejection in the console (and fails a test run that watches for them). Catching here
 * keeps the failure a rendered state — {@link failed} — which is what the user needs, and leaves no
 * rejection behind. The placeholder it resolves with is never shown, because `failed` has already
 * switched the template to the alert.
 */
const ChatPanel = defineAsyncComponent({
  loader: async () => {
    try {
      return await import('./ChatPanel.vue');
    } catch {
      failed.value = true;
      return { render: () => null };
    }
  }
});

/**
 * Reload the page so the browser fetches the current deployment's chunks.
 */
function reloadPage(): void {
  window.location.reload();
}
</script>

<template>
  <v-navigation-drawer
    v-if="failed"
    location="right"
    temporary
    :model-value="true"
    width="420"
    aria-label="Assistant"
  >
    <v-alert type="error" variant="tonal" role="alert" class="ma-3" data-testid="chat-chunk-error">
      The assistant could not be loaded, usually because a newer version was just deployed.
      <template #append><v-btn variant="text" @click="reloadPage">Reload</v-btn></template>
    </v-alert>
    <div class="d-flex justify-end pa-3">
      <v-btn variant="text" data-testid="chat-close" @click="emit('close')">Close</v-btn>
    </div>
  </v-navigation-drawer>
  <Suspense v-else>
    <ChatPanel @close="emit('close')" />
    <template #fallback>
      <v-navigation-drawer
        location="right"
        temporary
        :model-value="true"
        width="420"
        aria-label="Assistant"
      >
        <v-progress-linear
          indeterminate
          aria-label="Loading the assistant"
          data-testid="chat-loading"
        />
      </v-navigation-drawer>
    </template>
  </Suspense>
</template>
