<script setup lang="ts">
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { computed, onMounted, ref } from "vue";
import { useLinksStore, type ShortLink } from "../stores/links";

const links = useLinksStore();
const destination = ref("");
const editing = ref<ShortLink | null>(null);
const editDialog = ref(false);
const editDestination = ref("");
const message = ref("");
const pending = ref(false);
const copiedCode = ref("");

/** Public absolute URL for a short-link code. */
const publicLink = computed(
  () => (code: string) =>
    new URL(`/l/${code}`, window.location.origin).toString(),
);

/** Create a link and reset the create form when the API accepts it. */
async function createLink(): Promise<void> {
  message.value = "";
  pending.value = true;
  try {
    const link = await links.create(destination.value);
    destination.value = "";
    message.value = `Created ${publicLink.value(link.code)}.`;
  } catch (error) {
    message.value =
      error instanceof Error
        ? error.message
        : "Could not create the short link.";
  } finally {
    pending.value = false;
  }
}

/** Copy the public short URL without navigating away from the administrator page. */
async function copyLink(code: string): Promise<void> {
  await navigator.clipboard.writeText(publicLink.value(code));
  copiedCode.value = code;
  message.value = "Short URL copied to the clipboard.";
}

/** Delete a link after the browser's explicit confirmation. */
async function deleteLink(code: string): Promise<void> {
  if (!window.confirm("Delete this short link? This cannot be undone.")) {
    return;
  }
  message.value = "";
  try {
    await links.delete(code);
    message.value = "Short link deleted.";
  } catch (error) {
    message.value =
      error instanceof Error
        ? error.message
        : "Could not delete the short link.";
  }
}

/** Open the edit dialog with the current destination. */
function openEdit(link: ShortLink): void {
  editing.value = link;
  editDestination.value = link.destination;
  editDialog.value = true;
}

/** Persist an edited destination and close the dialog only after success. */
async function saveEdit(): Promise<void> {
  throwIfNull(editing.value, "Cannot save an edit without a selected link.");
  pending.value = true;
  message.value = "";
  try {
    await links.update(editing.value.code, editDestination.value);
    editDialog.value = false;
    editing.value = null;
    message.value = "Destination updated.";
  } catch (error) {
    message.value =
      error instanceof Error
        ? error.message
        : "Could not update the short link.";
  } finally {
    pending.value = false;
  }
}

onMounted(async () => {
  try {
    await links.load();
  } catch (error) {
    message.value =
      error instanceof Error ? error.message : "Could not load short links.";
  }
});
</script>

<template>
  <v-container class="py-6" max-width="1040">
    <header class="mb-6">
      <p class="text-overline text-orange-accent-4">Cloudflare Workers KV</p>
      <h1 class="text-h3 font-weight-bold">Link Forge</h1>
      <p class="text-body-1 mt-2">Create redirects that are managed at the edge and observable in Workers Logs.</p>
    </header>

    <v-alert v-if="message" class="mb-5" closable type="info" @click:close="message = ''">{{ message }}</v-alert>

    <v-card class="mb-6" elevation="3" title="Create a short link">
      <v-card-text>
        <form class="d-flex flex-column flex-sm-row align-start ga-3" @submit.prevent="createLink">
          <v-text-field
            v-model="destination"
            autofocus
            class="flex-grow-1"
            hide-details="auto"
            label="Destination URL"
            placeholder="https://customer.example.com/campaign"
            required
            type="url"
          />
          <v-btn color="orange-darken-2" :loading="pending" type="submit">Create short link</v-btn>
        </form>
      </v-card-text>
    </v-card>

    <section aria-labelledby="links-heading">
      <div class="d-flex align-center justify-space-between mb-3">
        <h2 id="links-heading" class="text-h5">Managed links</h2>
        <v-progress-circular v-if="links.loading" aria-label="Loading links" indeterminate size="24" />
      </div>
      <v-card v-if="!links.loading && links.links.length === 0" variant="outlined">
        <v-card-text>No links yet. Create one above to begin the demonstration.</v-card-text>
      </v-card>
      <v-list v-else aria-label="Managed short links" lines="three">
        <v-list-item v-for="link in links.links" :key="link.code" class="px-0 py-3">
          <template #title>
            <a :href="`/l/${link.code}`" rel="noreferrer" target="_blank">{{ publicLink(link.code) }}</a>
          </template>
          <template #subtitle>
            <span class="d-block text-truncate">{{ link.destination }}</span>
            <span class="text-caption">Updated {{ new Date(link.updatedAt).toLocaleString() }}</span>
          </template>
          <template #append>
            <div class="d-flex ga-1">
              <v-btn :aria-label="`Copy ${link.code}`" size="small" variant="text" @click="copyLink(link.code)">Copy</v-btn>
              <v-btn :aria-label="`Edit ${link.code}`" size="small" variant="text" @click="openEdit(link)">Edit</v-btn>
              <v-btn :aria-label="`Delete ${link.code}`" color="error" size="small" variant="text" @click="deleteLink(link.code)">Delete</v-btn>
            </div>
          </template>
          <v-chip v-if="copiedCode === link.code" class="mt-2" size="small">Copied</v-chip>
        </v-list-item>
      </v-list>
    </section>

    <v-dialog v-model="editDialog" max-width="640">
      <v-card title="Edit destination">
        <v-card-text>
          <v-text-field v-model="editDestination" label="Destination URL" required type="url" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="editDialog = false">Cancel</v-btn>
          <v-btn color="orange-darken-2" :loading="pending" @click="saveEdit">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
