<script setup lang="ts">
/**
 * Searchable contact selection over the contacts API, for one contact or many.
 *
 * A thin composition of Vuetify's `VAutocomplete`, which already provides keyboard operation (arrow
 * keys, Enter, Backspace on chips) and the combobox ARIA pattern; this component only adds
 * debounced server-side search. In `multiple` mode the selection is shown as closable chips, and
 * the chosen contacts stay listed even when they are not in the current search results.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { api } from '../services/api-client.ts';
import type { PickedContact } from '../services/deal-draft.ts';

const props = defineProps<{
  /**
   * Field label.
   */
  label: string;
  /**
   * Allow several contacts.
   */
  multiple?: boolean;
  /**
   * Validation messages.
   */
  errorMessages?: string[];
}>();

/**
 * The selection: one contact (or `null`), or an array in `multiple` mode.
 */
const model = defineModel<PickedContact | PickedContact[] | null>({ required: true });

const search = ref('');
const results = shallowRef<PickedContact[]>([]);
const loading = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const items = computed(() => {
  const selected = Array.isArray(model.value) ? model.value : model.value ? [model.value] : [];
  const seen = new Set(selected.map((item) => item.id));
  return [...selected, ...results.value.filter((item) => !seen.has(item.id))];
});

/**
 * Select a search result using a native button, even when the autocomplete menu is closed. This
 * keeps selection available to keyboard and touch users while asynchronous results arrive.
 *
 * @param contact The selected contact.
 */
const availableResults = computed(() => {
  const selected = Array.isArray(model.value) ? model.value : model.value ? [model.value] : [];
  const selectedIds = new Set(selected.map((item) => item.id));
  const term = search.value.trim().toLowerCase();
  return results.value.filter(
    (contact) => !selectedIds.has(contact.id) && contact.displayName.toLowerCase().includes(term)
  );
});

/**
 * Select a search result using a native button, even when the autocomplete menu is closed. This
 * keeps selection available to keyboard and touch users while asynchronous results arrive.
 *
 * @param contact The selected contact.
 */
function addContact(contact: PickedContact): void {
  if (props.multiple) {
    const selected = Array.isArray(model.value) ? model.value : [];
    if (!selected.some((item) => item.id === contact.id)) {
      model.value = [...selected, contact];
    }
  } else {
    model.value = contact;
  }
  search.value = '';
}

/**
 * Use Enter to select the first matching result, rather than submitting the parent activity form.
 */
function selectFirstResult(): void {
  const first = availableResults.value[0];
  if (first !== undefined && search.value.trim() !== '') {
    addContact(first);
  }
}

/**
 * Fetch matching contacts, ignoring responses to superseded searches.
 *
 * @param term Search text.
 */
async function lookup(term: string): Promise<void> {
  const current = ++generation;
  loading.value = true;
  try {
    const page = await api.contacts(term.trim() === '' ? {} : { q: term.trim() });
    if (current === generation) {
      results.value = page.items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        companyId: item.companyId
      }));
    }
  } catch {
    if (current === generation) {
      results.value = [];
    }
  } finally {
    if (current === generation) {
      loading.value = false;
    }
  }
}

watch(
  search,
  (term) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void lookup(term ?? ''), 250);
  },
  { immediate: true }
);
</script>

<template>
  <v-text-field
    v-model="search"
    :label="`Search ${props.label.toLowerCase()}`"
    type="search"
    clearable
    @keydown.enter.stop.prevent="selectFirstResult"
  />
  <v-autocomplete
    v-model="model"
    :items="items"
    item-title="displayName"
    item-value="id"
    return-object
    :multiple="props.multiple"
    :chips="props.multiple"
    :closable-chips="props.multiple"
    :label="props.label"
    :loading="loading"
    :error-messages="props.errorMessages"
    no-filter
    clearable
    no-data-text="No matching contacts"
  />
  <!-- Announces asynchronous results, which arrive after typing stops (WCAG 4.1.3). -->
  <div class="text-caption text-medium-emphasis" aria-live="polite" data-testid="picker-status">
    <template v-if="search.trim() !== '' && !loading">
      {{
        availableResults.length === 0
          ? 'No matching contacts'
          : `${availableResults.length} matching ${availableResults.length === 1 ? 'contact' : 'contacts'}`
      }}
    </template>
  </div>
  <v-list
    v-if="search.trim() !== ''"
    density="compact"
    :aria-label="`Search results for ${props.label}`"
  >
    <v-list-item v-for="contact in availableResults" :key="contact.id" :title="contact.displayName">
      <template #append>
        <v-btn
          size="small"
          variant="text"
          :aria-label="`Add ${contact.displayName} to ${props.label}`"
          @click="addContact(contact)"
          >Add</v-btn
        >
      </template>
    </v-list-item>
  </v-list>
</template>
