<script setup lang="ts">
import FeatherIcon from "vue-feather";
import { shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import MediaPreview from "../components/MediaPreview.vue";
import { formatDate, formatFileSize, type MediaItem } from "../media";
import { useLibraryStore } from "../stores/library";
import { publicViewerUrl } from "../viewer";

const route = useRoute();
const library = useLibraryStore();
const media = shallowRef<MediaItem | null>(null);

/** Return the public Worker content endpoint for the active item. */
function contentUrl(id: string): string {
  return publicViewerUrl(`/api/library/${encodeURIComponent(id)}/content`);
}

watch(
  () => route.params.id,
  async (id) => {
    media.value = typeof id === "string" ? await library.loadItem(id) : null;
  },
  { immediate: true },
);
</script>

<template>
  <v-container class="py-8" max-width="960">
    <v-btn class="mb-5" to="/" variant="text">
      <FeatherIcon aria-hidden="true" size="18" type="arrow-left" />
      <span class="ml-2">Back to library</span>
    </v-btn>
    <v-progress-linear v-if="library.loading" color="primary" indeterminate />
    <v-alert v-else-if="library.error" type="error" variant="tonal">{{ library.error }}</v-alert>
    <article v-else-if="media" class="detail-layout">
      <MediaPreview :media="media" :source="contentUrl(media.id)" @play="library.recordPlay(media.id)" />
      <section>
        <p class="eyebrow">Published media</p>
        <h1 class="text-h3 font-weight-bold mt-2">{{ media.title }}</h1>
        <dl class="metadata mt-6">
          <div><dt>Type</dt><dd>{{ media.contentType }}</dd></div>
          <div><dt>Size</dt><dd>{{ formatFileSize(media.sizeBytes) }}</dd></div>
          <div><dt>Published</dt><dd>{{ media.publishedAt ? formatDate(media.publishedAt) : "Not published" }}</dd></div>
        </dl>
        <v-btn class="mt-7" color="primary" :href="contentUrl(media.id)" download size="large">
          <FeatherIcon aria-hidden="true" size="18" type="download" />
          <span class="ml-2">Download media</span>
        </v-btn>
      </section>
    </article>
  </v-container>
</template>

<style scoped>
.detail-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(15rem, 0.7fr);
  gap: 2rem;
}

.eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.metadata {
  display: grid;
  gap: 1rem;
}

.metadata div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
}

.metadata dd {
  margin: 0;
  text-align: right;
}

@media (max-width: 700px) {
  .detail-layout {
    grid-template-columns: 1fr;
  }
}
</style>
