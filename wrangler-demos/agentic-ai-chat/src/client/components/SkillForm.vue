<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { CreateSkillInput } from "../stores/skills";

/** Properties supplied to the skill-creation form (docs/06-AGENTIC-CHAT.md Phase 11, US-10). */
interface Props {
  /** `true` while a submitted skill is still being created -- disables the form so a second
   * submit cannot race the first. */
  submitting: boolean;
}

/** Events emitted by the form. */
interface Emits {
  /** Submit a new skill's name, description, and source. */
  create: [input: CreateSkillInput];
}

defineProps<Props>();
const emit = defineEmits<Emits>();

const name = shallowRef("");
const description = shallowRef("");
const sourceType = shallowRef<"upload" | "url">("upload");
const content = shallowRef("");
const url = shallowRef("");

/** Whether the form currently has enough filled in to submit -- mirrors
 * `ChatComposer.vue`'s own "disable Send until there is something to send" convention. */
const canSubmit = computed(() => {
  if (name.value.trim().length === 0 || description.value.trim().length === 0) {
    return false;
  }
  return sourceType.value === "upload"
    ? content.value.trim().length > 0
    : url.value.trim().length > 0;
});

/** Submit the form's current fields as one {@link CreateSkillInput}, then clear every field. */
function submit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit("create", {
    name: name.value.trim(),
    description: description.value.trim(),
    source:
      sourceType.value === "upload"
        ? { type: "upload", content: content.value }
        : { type: "url", url: url.value.trim() },
  });
  name.value = "";
  description.value = "";
  content.value = "";
  url.value = "";
}
</script>

<template>
  <form class="skill-form" @submit.prevent="submit">
    <div class="field-row">
      <label class="field-label" for="skill-name">Name</label>
      <input
        id="skill-name"
        v-model="name"
        :disabled="submitting"
        placeholder="For example, brand-voice"
        type="text"
      />
    </div>

    <div class="field-row">
      <label class="field-label" for="skill-description">Description</label>
      <input
        id="skill-description"
        v-model="description"
        :disabled="submitting"
        placeholder="When should the agent use this skill?"
        type="text"
      />
    </div>

    <fieldset class="field-row source-type" :disabled="submitting">
      <legend class="field-label">Source</legend>
      <label>
        <input v-model="sourceType" type="radio" value="upload" />
        Paste content
      </label>
      <label>
        <input v-model="sourceType" type="radio" value="url" />
        Fetch from a URL
      </label>
    </fieldset>

    <div v-if="sourceType === 'upload'" class="field-row">
      <label class="field-label" for="skill-content">Instructions</label>
      <textarea
        id="skill-content"
        v-model="content"
        :disabled="submitting"
        placeholder="Write this skill's instructions in Markdown…"
        rows="4"
      />
    </div>
    <div v-else class="field-row">
      <label class="field-label" for="skill-url">URL</label>
      <input
        id="skill-url"
        v-model="url"
        :disabled="submitting"
        placeholder="https://example.com/skill.md"
        type="url"
      />
    </div>

    <button class="submit-button" :disabled="submitting || !canSubmit" type="submit">
      {{ submitting ? "Adding…" : "Add skill" }}
    </button>
  </form>
</template>

<style scoped>
.skill-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 32rem;
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
}

input[type="text"],
input[type="url"],
textarea {
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  font: inherit;
  padding: 0.5rem 0.75rem;
}

.source-type {
  border: none;
  display: flex;
  gap: 1.5rem;
  padding: 0;
}

.source-type label {
  align-items: center;
  display: inline-flex;
  gap: 0.375rem;
}

.submit-button {
  align-self: flex-start;
  background: rgb(var(--v-theme-primary));
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-primary));
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  min-height: 2.5rem;
  padding: 0.5rem 1.25rem;
}

.submit-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
