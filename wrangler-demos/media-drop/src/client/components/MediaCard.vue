<script setup lang="ts">
import FeatherIcon from "vue-feather";
import { formatDate, formatFileSize, type MediaItem } from "../media";
import MediaPreview from "./MediaPreview.vue";

/** Input required to display one media item and its available actions. */
interface Props {
  /** Metadata to render. */
  media: MediaItem;
  /** Worker content endpoint authorized for this viewer. */
  source: string;
  /** Whether the card is rendered in the owner-only studio. */
  studio?: boolean;
  /** Optional public detail-page destination. */
  detailTo?: string;
}

/** Actions emitted from a studio card. */
interface Emits {
  /** Request publication of a draft. */
  publish: [id: string];
  /** Request deletion after the parent confirms it. */
  remove: [item: MediaItem];
  /** Report a native audio or video playback start. */
  play: [id: string];
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <v-card class="media-card" variant="outlined">
    <MediaPreview :media="props.media" :source="props.source" @play="emit('play', props.media.id)" />
    <v-card-item>
      <template #title>{{ props.media.title }}</template>
      <template #subtitle>
        {{ formatFileSize(props.media.sizeBytes) }} · Added {{ formatDate(props.media.createdAt) }}
      </template>
      <template v-if="props.studio" #append>
        <v-chip :color="props.media.status === 'published' ? 'success' : 'warning'" size="small">
          {{ props.media.status }}
        </v-chip>
      </template>
    </v-card-item>
    <v-card-actions>
      <v-btn class="action-button" :href="props.source" :aria-label="`Download ${props.media.title}`" download variant="text">
        <FeatherIcon aria-hidden="true" size="18" type="download" />
        <span class="ml-2">Download</span>
      </v-btn>
      <v-btn v-if="props.detailTo" class="action-button" :to="props.detailTo" :aria-label="`View details for ${props.media.title}`" variant="text">
        <FeatherIcon aria-hidden="true" size="18" type="info" />
        <span class="ml-2">View details</span>
      </v-btn>
      <template v-if="props.studio">
        <v-spacer />
        <v-btn
          v-if="props.media.status === 'draft'"
          class="action-button"
          color="primary"
          :aria-label="`Publish ${props.media.title}`"
          variant="text"
          @click="emit('publish', props.media.id)"
        >
          <FeatherIcon aria-hidden="true" size="18" type="send" />
          <span class="ml-2">Publish</span>
        </v-btn>
        <v-btn class="action-button" color="error" :aria-label="`Delete ${props.media.title}`" variant="text" @click="emit('remove', props.media)">
          <FeatherIcon aria-hidden="true" size="18" type="trash-2" />
          <span class="ml-2">Delete</span>
        </v-btn>
      </template>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.media-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0.75rem;
}

:deep(.v-card-actions) {
  margin-top: auto;
  padding-top: 1rem;
}

.action-button {
  border: 1px solid #c7d0df;
}
</style>
