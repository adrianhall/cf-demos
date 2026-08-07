<script setup lang="ts">
import { ref, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { blueprints } from "../../../graph/blueprints";
import type { BlueprintId } from "../../../graph/blueprints";

/**
 * Modal form for creating a diagram: a title plus one of a few real starter blueprints
 * (`../../../graph/blueprints.ts`). Kept modest per the Phase 2 brief rather than offering every
 * prior-art template.
 */
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
  create: [title: string, blueprintId: BlueprintId];
}>();

const title = ref("");
const blueprintId = ref<BlueprintId>("blank");
const pending = defineModel<boolean>("pending", { default: false });

/** Emit the create event with the current form values, then close the dialog. */
function submit(): void {
  if (!title.value.trim()) {
    return;
  }
  emit("create", title.value.trim(), blueprintId.value);
}

// Reset the form every time the dialog opens, so a previous submission's title/blueprint never
// lingers into the next one.
watch(open, (isOpen) => {
  if (isOpen) {
    title.value = "";
    blueprintId.value = "blank";
  }
});
</script>

<template>
  <v-dialog v-model="open" max-width="640">
    <v-card title="Create a diagram">
      <v-card-text>
        <v-text-field
          v-model="title"
          autofocus
          density="compact"
          label="Diagram title"
          required
          variant="outlined"
        />
        <v-radio-group v-model="blueprintId" density="compact" label="Starter blueprint">
          <v-radio
            v-for="blueprint in blueprints"
            :key="blueprint.id"
            :label="`${blueprint.label} — ${blueprint.description}`"
            :value="blueprint.id"
          />
        </v-radio-group>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :disabled="!title.trim()" :loading="pending" @click="submit">
          Create
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
