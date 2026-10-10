<script setup lang="ts">
import FeatherIcon from "vue-feather";
import { onMounted } from "vue";
import MediaCard from "../components/MediaCard.vue";
import { useLibraryStore } from "../stores/library";
import { publicViewerUrl } from "../viewer";

const library = useLibraryStore();

/** Return the public Worker content endpoint for a published item. */
function contentUrl(id: string): string {
  return publicViewerUrl(`/api/library/${encodeURIComponent(id)}/content`);
}

onMounted(() => library.load());
</script>

<template>
  <v-container class="page py-8" max-width="1200">
    <header class="hero mb-8">
      <div>
        <p class="eyebrow">Cloudflare R2 + D1</p>
        <h1 class="hero-title">Media Drop</h1>
        <p class="hero-copy">A public collection of images, sound, and short films published from the edge.</p>
      </div>
      <!-- A document navigation lets Cloudflare Access (or its local Vite emulator) gate the page. -->
      <v-btn color="primary" href="/studio" size="large">
        <FeatherIcon aria-hidden="true" size="18" type="upload-cloud" />
        <span class="ml-2">Sign in to upload</span>
      </v-btn>
    </header>

    <v-alert v-if="library.error" class="mb-5" type="error" variant="tonal">{{ library.error }}</v-alert>

    <div class="section-heading mb-4">
      <div>
        <p class="eyebrow mb-1">Public library</p>
        <h2 class="text-h4">Recently published</h2>
      </div>
      <v-btn :loading="library.loading" aria-label="Refresh library" icon variant="text" @click="library.load">
        <FeatherIcon aria-hidden="true" size="20" type="refresh-cw" />
      </v-btn>
    </div>

    <v-progress-linear v-if="library.loading && library.media.length === 0" color="primary" indeterminate />
    <v-card v-else-if="library.media.length === 0" class="empty-state" variant="outlined">
      <v-card-text>
        <FeatherIcon aria-hidden="true" size="28" type="inbox" />
        <p class="text-h6 mt-3">The library is waiting for its first release.</p>
        <p class="text-body-2">Sign in to the studio to upload an image, audio file, or video as a private draft.</p>
      </v-card-text>
    </v-card>
    <v-row v-else>
      <v-col v-for="item in library.media" :key="item.id" cols="12" md="6" lg="4">
        <MediaCard :detail-to="`/media/${item.id}`" :media="item" :source="contentUrl(item.id)" @play="library.recordPlay" />
      </v-col>
    </v-row>
  </v-container>
</template>

<style scoped>
.page {
  min-height: 100%;
}

.hero,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.hero {
  align-items: end;
  padding: 2rem;
  color: rgb(var(--v-theme-on-primary));
  background: linear-gradient(135deg, #0f3060, #345eea 65%, #82d0ff);
  border-radius: 1.5rem;
}

.hero-title {
  font-size: clamp(2.5rem, 7vw, 4.5rem);
  font-weight: 800;
  letter-spacing: -0.06em;
  line-height: 0.95;
}

.hero-copy {
  max-width: 38rem;
  margin: 1rem 0 0;
  font-size: 1.1rem;
}

.eyebrow {
  margin: 0;
  color: #8fcaff;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.section-heading .eyebrow {
  color: rgb(var(--v-theme-primary));
}

.empty-state {
  text-align: center;
}

@media (max-width: 600px) {
  .hero,
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
