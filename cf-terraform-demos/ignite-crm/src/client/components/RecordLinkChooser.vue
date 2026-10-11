<script setup lang="ts">
/**
 * Choose any mix of contacts, companies, deals, and projects, shown as removable chips: the typed
 * multi-record link chooser for notes.
 *
 * Built from Vuetify primitives — `VSelect` for the record type, `VTextField` for the search,
 * `VList` for results, and closable `VChip`s for the selection — because no single Vuetify
 * component chooses across several record types. (`ContactPicker` wraps `VAutocomplete` for one
 * type; one autocomplete over four types would mix result kinds in one list with no way to say
 * which kind to look for.) Everything is reachable without a pointer: Tab reaches each control,
 * Enter in the search adds the first result, every result has an "Add" button, and each chip's
 * close button is a labelled button ("Remove Northwind Traders").
 *
 * The component takes data and emits intent. The parent performs searches (it receives `search` and
 * passes `results` back), so this component never calls the API and can be reused anywhere a typed
 * record selection is needed.
 *
 * @fires search When the type or search text changes (debounced), with the type and text.
 */
import { computed, ref, watch } from 'vue';
import { NOTE_LINK_TYPES, type NoteLinkType } from '../../shared/api/notes.ts';
import { LINK_TYPE_LABELS, type LinkOption } from '../services/note-draft.ts';

const props = defineProps<{
  /**
   * Field label.
   */
  label: string;
  /**
   * Search results for the current type and text, supplied by the parent.
   */
  results: readonly LinkOption[];
  /**
   * Whether a search is in flight.
   */
  loading?: boolean;
  /**
   * A failed search. Displayed as a retryable error, not as "no matching records".
   */
  searchError?: string | null;
  /**
   * Record types the user may choose from (defaults to all four).
   */
  types?: readonly NoteLinkType[];
  /**
   * Validation messages for the selection as a whole.
   */
  errorMessages?: readonly string[];
  /**
   * Messages for individual chosen records, keyed by their position in the selection.
   */
  itemErrors?: Readonly<Record<number, string>>;
  /**
   * Disable changes (for example, while saving).
   */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /**
   * Search for records of `type` matching `text`.
   */
  search: [type: NoteLinkType, text: string];
}>();

/**
 * The selection, in the order the user chose it.
 */
const model = defineModel<LinkOption[]>({ required: true });

const typeItems = computed(() =>
  (props.types ?? NOTE_LINK_TYPES).map((value) => ({ title: LINK_TYPE_LABELS[value], value }))
);
const type = ref<NoteLinkType>(props.types?.[0] ?? 'contact');
const text = ref('');
let debounce: ReturnType<typeof setTimeout> | undefined;

/**
 * Results not already chosen.
 */
const available = computed(() => {
  const chosen = new Set(model.value.map((item) => `${item.type}:${item.id}`));
  return props.results.filter((item) => !chosen.has(`${item.type}:${item.id}`));
});

/**
 * Add a record to the selection.
 *
 * @param option The record.
 */
function add(option: LinkOption): void {
  if (!model.value.some((item) => item.type === option.type && item.id === option.id)) {
    model.value = [...model.value, option];
  }
}

/**
 * Remove a record from the selection.
 *
 * @param option The record.
 */
function remove(option: LinkOption): void {
  model.value = model.value.filter((item) => !(item.type === option.type && item.id === option.id));
}

/**
 * Enter in the search adds the first result instead of submitting the surrounding form.
 */
function addFirst(): void {
  const first = available.value[0];
  if (first !== undefined) {
    add(first);
    text.value = '';
  }
}

watch(
  [type, text],
  ([currentType, currentText]) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => emit('search', currentType, (currentText ?? '').trim()), 250);
  },
  { immediate: true }
);
</script>

<template>
  <fieldset class="record-link-chooser" :disabled="props.disabled">
    <legend class="text-body-1 mb-2">{{ props.label }}</legend>
    <div
      class="d-flex flex-wrap ga-2 mb-3"
      role="list"
      :aria-label="`${props.label}: ${model.length} chosen`"
      data-testid="chosen-links"
    >
      <span v-if="model.length === 0" class="text-body-2 text-medium-emphasis" role="listitem"
        >Nothing linked yet.</span
      >
      <div v-for="(item, index) in model" :key="`${item.type}:${item.id}`" role="listitem">
        <v-chip
          :color="
            props.itemErrors?.[index] ? 'error' : item.available === false ? undefined : 'secondary'
          "
          :variant="item.available === false ? 'outlined' : 'tonal'"
          closable
          :close-label="`Remove ${item.label}`"
          :disabled="props.disabled"
          @click:close="remove(item)"
        >
          <span class="text-medium-emphasis me-1">{{ LINK_TYPE_LABELS[item.type] }}:</span>
          {{ item.label }}
          <span v-if="item.available === false" class="ms-1">(deleted)</span>
        </v-chip>
        <div v-if="props.itemErrors?.[index]" class="text-error text-caption mt-1">
          {{ props.itemErrors[index] }}
        </div>
      </div>
    </div>
    <div
      v-if="(props.errorMessages ?? []).length > 0"
      class="text-error text-body-2 mb-2"
      role="alert"
    >
      {{ props.errorMessages?.[0] }}
    </div>
    <v-row density="compact">
      <v-col cols="12" sm="4">
        <v-select
          v-model="type"
          :items="typeItems"
          label="Record type"
          :disabled="props.disabled"
          hide-details
        />
      </v-col>
      <v-col cols="12" sm="8">
        <v-text-field
          v-model="text"
          :label="`Search ${LINK_TYPE_LABELS[type].toLowerCase()} records`"
          role="searchbox"
          :loading="props.loading"
          :disabled="props.disabled"
          clearable
          hide-details
          @keydown.enter.stop.prevent="addFirst"
        />
      </v-col>
    </v-row>
    <v-list
      density="compact"
      :aria-label="`${LINK_TYPE_LABELS[type]} results`"
      aria-live="polite"
      data-testid="link-results"
    >
      <v-list-item v-for="item in available" :key="`${item.type}:${item.id}`" :title="item.label">
        <template #append>
          <v-btn
            size="small"
            variant="text"
            :disabled="props.disabled"
            :aria-label="`Link ${LINK_TYPE_LABELS[item.type].toLowerCase()} ${item.label}`"
            @click="add(item)"
            >Add</v-btn
          >
        </template>
      </v-list-item>
      <v-list-item v-if="props.searchError" title="Could not search records">
        <template #subtitle>
          {{ props.searchError }}
        </template>
        <template #append>
          <v-btn variant="text" @click="emit('search', type, text.trim())">Retry search</v-btn>
        </template>
      </v-list-item>
      <v-list-item
        v-else-if="!props.loading && available.length === 0"
        :title="`No matching ${LINK_TYPE_LABELS[type].toLowerCase()} records`"
      />
    </v-list>
  </fieldset>
</template>

<style scoped>
.record-link-chooser {
  border: 0;
  margin: 0;
  min-width: 0;
  padding: 0;
}
</style>
