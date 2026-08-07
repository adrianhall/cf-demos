<script setup lang="ts">
import { computed, ref, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";
import { useArchitectureProposalStore } from "../../stores/architecture-proposal";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramCanvas from "./DiagramCanvas.vue";

/**
 * Owner/editor dialog for requesting, tracking, previewing, and accepting a Workflow-backed AI
 * architecture proposal (`docs/09-ARCHITECT.md`'s Phase 5 AI Workflow).
 *
 * `DiagramEditorView.vue` renders this for any member — owner or editor — matching the Worker's
 * own `POST /api/diagrams/:id/proposals` authorization. Every request still goes through the
 * Worker's independent membership check; this component is a UI convenience, not the
 * authorization boundary.
 */
const props = defineProps<{
  /** Diagram to propose an architecture for. */
  diagramId: string;
}>();
const open = defineModel<boolean>("open", { default: false });

const store = useArchitectureProposalStore();
const prompt = ref("");

/**
 * Matches the Worker's own `MAX_PROMPT_LENGTH` (`src/worker/architecture/validation.ts`).
 * Duplicated here rather than imported: that module also imports
 * `@adrianhall/cloudflare-toolkit/errors`, which does not belong in the client bundle — see
 * `docs/09-ARCHITECT.md`'s Source Organization boundary between `src/worker/` and `src/client/`.
 */
const MAX_PROMPT_LENGTH = 500;

const promptTooLong = computed(() => prompt.value.length > MAX_PROMPT_LENGTH);

/** A short, human-readable label for the current job's status. */
const statusLabel = computed(() => {
  switch (store.job?.status) {
    case "queued":
      return "Waiting for the Workflow to start…";
    case "summarizing":
      return "Summarizing the current diagram…";
    case "generating":
      return "Asking Workers AI for a proposal…";
    case "validating":
      return "Validating the proposal…";
    case "storing":
      return "Saving the proposal…";
    case "ready":
      return "Proposal ready.";
    case "failed":
      return "The proposal could not be generated.";
    default:
      return "";
  }
});

// Reset to a fresh prompt form every time the dialog is closed, so reopening it never shows a
// stale previous job's state.
watch(open, (isOpen) => {
  if (!isOpen) {
    store.dismiss();
    prompt.value = "";
  }
});

/** Start a new proposal job for the current prompt. */
async function submit(): Promise<void> {
  await store.start(props.diagramId, prompt.value);
}

/** Start a fresh job with the same prompt — Phase 5's retry is always a new job id. */
async function regenerate(): Promise<void> {
  store.dismiss();
  await store.start(props.diagramId, prompt.value);
}

/** Accept the current proposal, then close the dialog on success. */
async function acceptProposal(): Promise<void> {
  if (await store.accept()) {
    open.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="900">
    <v-card title="Ask Workers AI to propose an architecture">
      <v-card-text>
        <template v-if="!store.job">
          <p class="hint">
            Describe the application you want to build in a sentence or two. Workers AI will
            propose a small architecture using this demo's curated product catalog; you preview
            it before anything on the diagram changes.
          </p>
          <v-textarea
            v-model="prompt"
            :counter="MAX_PROMPT_LENGTH"
            :error="promptTooLong"
            auto-grow
            label="Application description"
            rows="2"
          />
          <v-alert v-if="store.error" type="error" variant="tonal">{{ store.error }}</v-alert>
          <v-btn
            color="primary"
            :disabled="prompt.trim().length === 0 || promptTooLong"
            :loading="store.starting"
            @click="submit"
          >
            <template #prepend><FeatherIcon name="zap" /></template>
            Generate proposal
          </v-btn>
        </template>

        <template v-else>
          <div aria-live="polite" class="status-row" role="status">
            <v-progress-circular
              v-if="store.isActive"
              color="primary"
              indeterminate
              size="20"
              width="2"
            />
            <FeatherIcon v-else-if="store.job.status === 'ready'" name="check" />
            <FeatherIcon v-else name="alert-triangle" />
            <span>{{ statusLabel }}</span>
          </div>

          <v-alert v-if="store.job.status === 'failed'" type="error" variant="tonal">
            The proposal could not be generated. You can try again.
          </v-alert>

          <v-alert
            v-if="store.acceptStaleness"
            type="warning"
            variant="tonal"
          >
            Someone changed the diagram since this proposal was generated. Please regenerate the
            proposal before accepting.
          </v-alert>
          <v-alert v-else-if="store.error" type="error" variant="tonal">{{ store.error }}</v-alert>

          <div v-if="store.job.status === 'ready' && store.proposal" class="preview">
            <p class="preview-label">Preview (read-only — nothing has changed yet):</p>
            <DiagramCanvas
              :edges="store.proposal.edges"
              :nodes="store.proposal.nodes"
              read-only
            />
          </div>

          <div class="actions">
            <v-btn
              v-if="store.job.status === 'ready' && !store.acceptStaleness"
              color="primary"
              :loading="store.accepting"
              @click="acceptProposal"
            >
              <template #prepend><FeatherIcon name="check" /></template>
              Accept
            </v-btn>
            <v-btn
              v-if="store.job.status === 'failed' || store.acceptStaleness"
              @click="regenerate"
            >
              <template #prepend><FeatherIcon name="refresh-cw" /></template>
              Regenerate
            </v-btn>
            <v-btn v-if="store.job.status === 'ready'" variant="text" @click="store.dismiss()">
              <template #prepend><FeatherIcon name="x" /></template>
              Discard
            </v-btn>
          </div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  margin-bottom: 1rem;
}
.status-row {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.preview {
  margin-top: 0.75rem;
}
.preview-label {
  color: rgb(var(--v-theme-on-surface-variant));
  margin-bottom: 0.5rem;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
</style>
