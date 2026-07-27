<script setup lang="ts">
import type { MediaItem } from "../media";

/** Input required to render an inline media preview. */
interface Props {
  /** Metadata that determines the media element. */
  media: MediaItem;
  /** Worker content endpoint authorized for this viewer. */
  source: string;
}

/** Playback event emitted by native audio and video controls. */
interface Emits {
  /** Signal that the viewer started media playback. */
  play: [];
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <img
    v-if="props.media.contentType.startsWith('image/')"
    :alt="props.media.title"
    class="media-preview"
    :src="props.source"
  />
  <audio v-else-if="props.media.contentType.startsWith('audio/')" class="media-preview" controls :src="props.source" @play="emit('play')">
    Your browser cannot play this audio file.
  </audio>
  <video v-else class="media-preview" controls :src="props.source" @play="emit('play')">
    Your browser cannot play this video file.
  </video>
</template>

<style scoped>
.media-preview {
  display: block;
  width: 100%;
  max-height: 19rem;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 0.75rem;
  object-fit: contain;
}
</style>
