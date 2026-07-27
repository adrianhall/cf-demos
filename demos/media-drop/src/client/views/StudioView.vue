<script setup lang="ts">
import FeatherIcon from "vue-feather";
import { computed, onMounted, shallowRef, useTemplateRef } from "vue";
import MediaCard from "../components/MediaCard.vue";
import UploadForm from "../components/UploadForm.vue";
import type { MediaItem } from "../media";
import { useStudioStore } from "../stores/studio";

const studio = useStudioStore();
const uploadForm = useTemplateRef<{ reset: () => void }>("uploadForm");
const uploadProgress = shallowRef<number | null>(null);
const message = shallowRef("");
const drafts = computed(() =>
  studio.media.filter((item) => item.status === "draft"),
);
const published = computed(() =>
  studio.media.filter((item) => item.status === "published"),
);

/** Return the owner-authorized Worker content endpoint for an item. */
function contentUrl(id: string): string {
  return `/api/studio/media/${encodeURIComponent(id)}/content`;
}

/** Upload a validated file and reset the form after the API creates its private draft. */
async function upload(request: { title: string; file: File }): Promise<void> {
  message.value = "";
  uploadProgress.value = 0;
  try {
    await studio.upload(request.title, request.file, (progress) => {
      uploadProgress.value = progress;
    });
    uploadForm.value?.reset();
    message.value =
      "Draft uploaded. It is visible only in your studio until published.";
  } catch (error) {
    studio.error =
      error instanceof Error ? error.message : "Could not upload the media.";
  } finally {
    uploadProgress.value = null;
  }
}

/** Publish an owned draft, making it visible in the public library. */
async function publish(id: string): Promise<void> {
  message.value = "";
  await studio.publish(id);
  if (!studio.error) {
    message.value = "Published to the public library.";
  }
}

/** Confirm irreversible deletion before removing the R2 object and D1 metadata. */
async function remove(item: MediaItem): Promise<void> {
  if (
    !window.confirm(
      `Delete “${item.title}”? This removes its object and metadata.`,
    )
  ) {
    return;
  }
  message.value = "";
  await studio.remove(item.id);
  if (!studio.error) {
    message.value = "Media deleted from R2 and D1.";
  }
}

onMounted(() => studio.load());
</script>

<template>
  <v-container class="py-8" max-width="1200">
    <header class="studio-header mb-8">
      <div>
        <p class="eyebrow">Creator studio</p>
        <h1 class="text-h3 font-weight-bold">Your media, at the edge.</h1>
        <p class="mt-2 text-body-1">{{ studio.email || "Checking your Cloudflare Access identity…" }}</p>
      </div>
      <v-btn href="/cdn-cgi/access/logout" variant="outlined">
        <FeatherIcon aria-hidden="true" size="18" type="log-out" />
        <span class="ml-2">Log out</span>
      </v-btn>
    </header>

    <v-alert v-if="studio.error" class="mb-5" type="error" variant="tonal">{{ studio.error }}</v-alert>
    <v-alert v-if="message" class="mb-5" closable type="success" variant="tonal" @click:close="message = ''">{{ message }}</v-alert>
    <UploadForm ref="uploadForm" :progress="uploadProgress" @upload="upload" />

    <section class="mt-10" aria-labelledby="drafts-heading">
      <div class="section-heading mb-4">
        <div><p class="eyebrow">Private</p><h2 id="drafts-heading" class="text-h4">Drafts</h2></div>
        <v-chip color="warning" variant="tonal">{{ drafts.length }} private</v-chip>
      </div>
      <v-card v-if="!studio.loading && drafts.length === 0" variant="outlined"><v-card-text>No drafts yet.</v-card-text></v-card>
      <v-row v-else>
        <v-col v-for="item in drafts" :key="item.id" cols="12" md="6" lg="4">
          <MediaCard studio :media="item" :source="contentUrl(item.id)" @play="studio.recordPlay" @publish="publish" @remove="remove" />
        </v-col>
      </v-row>
    </section>

    <section class="mt-10" aria-labelledby="published-heading">
      <div class="section-heading mb-4">
        <div><p class="eyebrow">Live</p><h2 id="published-heading" class="text-h4">Published</h2></div>
        <v-chip color="success" variant="tonal">{{ published.length }} live</v-chip>
      </div>
      <v-card v-if="!studio.loading && published.length === 0" variant="outlined"><v-card-text>Published media will appear here.</v-card-text></v-card>
      <v-row v-else>
        <v-col v-for="item in published" :key="item.id" cols="12" md="6" lg="4">
          <MediaCard studio :media="item" :source="contentUrl(item.id)" @play="studio.recordPlay" @remove="remove" />
        </v-col>
      </v-row>
    </section>
  </v-container>
</template>

<style scoped>
.studio-header,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.eyebrow {
  margin: 0;
  color: rgb(var(--v-theme-primary));
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

@media (max-width: 600px) {
  .studio-header,
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
