<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
/**
 * Contacts: debounced, URL-backed search, cursor paging, and the create-contact dialog.
 */
import { mdiAccountPlus, mdiMagnify } from '@mdi/js';
import type { ContactSummary } from '../../shared/api/crm.ts';
import ContactForm, { type ContactDraft } from '../components/ContactForm.vue';
import ResourceState from '../components/ResourceState.vue';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { api, ApiError, newIdempotencyKey } from '../services/api-client.ts';

const route = useRoute();
const router = useRouter();
const { can } = useSession();

const search = ref(typeof route.query.q === 'string' ? route.query.q : '');
const items = ref<ContactSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);

const page = useResource(async (signal) => {
  const result = await api.contacts({ q: search.value.trim() }, signal);
  items.value = [...result.items];
  nextCursor.value = result.nextCursor;
  return result;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void router.replace({ query: value.trim() === '' ? {} : { q: value.trim() } });
    void page.load();
  }, 250);
});

/**
 * Append the next page.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  loadingMore.value = true;
  try {
    const result = await api.contacts({ q: search.value.trim(), cursor: nextCursor.value });
    items.value = [...items.value, ...result.items];
    nextCursor.value = result.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

const dialog = ref(false);
const submitting = ref(false);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
let idempotencyKey = newIdempotencyKey();

/**
 * Open the create dialog with a fresh intent.
 */
function openCreate(): void {
  fieldErrors.value = {};
  formError.value = null;
  idempotencyKey = newIdempotencyKey();
  dialog.value = true;
}

/**
 * Submit a new contact; on success open it, on failure keep the draft and show errors.
 *
 * The idempotency key is reused across retries of the same draft, so a submission whose response
 * was lost cannot create a duplicate.
 *
 * @param draft The form draft.
 */
async function create(draft: ContactDraft): Promise<void> {
  submitting.value = true;
  fieldErrors.value = {};
  formError.value = null;
  try {
    const contact = await api.createContact(
      {
        firstName: draft.firstName,
        lastName: draft.lastName,
        email: draft.email,
        phone: draft.phone,
        jobTitle: draft.jobTitle,
        companyName: draft.companyName
      },
      idempotencyKey
    );
    dialog.value = false;
    await router.push({ name: 'contact', params: { id: contact.id } });
  } catch (caught) {
    const error =
      caught instanceof ApiError
        ? caught
        : new ApiError('server', 'Could not create the contact.', 0);
    fieldErrors.value = { ...error.fields };
    formError.value =
      error.kind === 'forbidden' ? 'Your role does not allow creating contacts.' : error.message;
  } finally {
    submitting.value = false;
  }
}

onMounted(() => void page.load());
</script>

<template>
  <section aria-labelledby="contacts-title">
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <h1 id="contacts-title" class="text-h4 flex-grow-1">Contacts</h1>
      <v-btn
        v-if="can('crm.write')"
        color="primary"
        :prepend-icon="mdiAccountPlus"
        @click="openCreate"
        >New contact</v-btn
      >
    </div>
    <v-alert v-if="!can('crm.write')" type="info" variant="tonal" density="compact" class="mb-4">
      Your role can view contacts but not create or change them.
    </v-alert>
    <v-text-field
      v-model="search"
      label="Search contacts"
      :prepend-inner-icon="mdiMagnify"
      clearable
      hint="Name, e-mail, or company"
      role="searchbox"
      class="mb-4"
    />
    <ResourceState
      :state="page.state.value"
      :error="page.error.value"
      :empty="items.length === 0"
      :has-data="page.data.value !== null"
      :empty-title="search ? 'No matching contacts' : 'No contacts yet'"
      :empty-text="search ? 'Try a different search.' : 'Create your first contact to get started.'"
      @retry="page.load"
    >
      <v-list lines="two" aria-label="Contacts">
        <v-list-item
          v-for="contact in items"
          :key="contact.id"
          :to="{ name: 'contact', params: { id: contact.id } }"
          :title="contact.displayName"
          :subtitle="
            [contact.jobTitle, contact.companyName, contact.email].filter(Boolean).join(' · ')
          "
        />
      </v-list>
      <div v-if="nextCursor" class="d-flex justify-center mt-2">
        <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
      </div>
    </ResourceState>

    <v-dialog v-model="dialog" max-width="720" aria-labelledby="contact-form-title">
      <v-card>
        <v-card-title><h2 id="contact-form-title" class="text-h6">New contact</h2></v-card-title>
        <v-card-text>
          <ContactForm
            :submitting="submitting"
            :field-errors="fieldErrors"
            :form-error="formError"
            @submit="create"
            @cancel="dialog = false"
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </section>
</template>
