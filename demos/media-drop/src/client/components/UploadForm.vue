<script setup lang="ts">
import FeatherIcon from "vue-feather";
import { shallowRef } from "vue";
import { allowedMediaTypes, maxMediaSizeBytes } from "../media";

/** Upload request emitted after local metadata and file validation pass. */
interface UploadRequest {
  /** Trimmed creator-supplied title. */
  title: string;
  /** Browser-selected media file. */
  file: File;
}

/** Events emitted by the media upload form. */
interface Emits {
  /** Submit a locally validated media request. */
  upload: [request: UploadRequest];
}

/** Upload state supplied by the studio view. */
interface Props {
  /** Current browser transfer percentage, or `null` while idle. */
  progress: number | null;
}

const emit = defineEmits<Emits>();
const props = defineProps<Props>();
const title = shallowRef("");
const file = shallowRef<File | null>(null);
const error = shallowRef("");

/** Validate local upload inputs before opening a network request. */
function submit(): void {
  const normalizedTitle = title.value.trim();
  if (normalizedTitle.length === 0 || normalizedTitle.length > 280) {
    error.value = "Enter a title between 1 and 280 characters.";
    return;
  }
  if (file.value === null) {
    error.value = "Choose an image, audio file, or video file.";
    return;
  }
  if (!allowedMediaTypes.has(file.value.type)) {
    error.value = "This file type is not supported.";
    return;
  }
  if (file.value.size > maxMediaSizeBytes) {
    error.value = "Media must not exceed 100 MB.";
    return;
  }
  error.value = "";
  emit("upload", { file: file.value, title: normalizedTitle });
}

/** Reset the form after a successful upload. */
function reset(): void {
  title.value = "";
  file.value = null;
  error.value = "";
}

defineExpose({ reset });
</script>

<template>
  <v-card variant="outlined">
    <v-card-item title="Upload media" subtitle="New uploads stay private as drafts until you publish them." />
    <v-card-text>
      <form class="upload-form" @submit.prevent="submit">
        <v-text-field v-model="title" hide-details="auto" label="Title" maxlength="280" required />
        <v-file-input
          v-model="file"
          accept="image/gif,image/jpeg,image/png,image/webp,audio/mpeg,audio/ogg,audio/wav,video/mp4,video/webm"
          hide-details="auto"
          label="Image, audio, or short video"
          prepend-icon=""
          required
          show-size
        />
        <v-alert v-if="error" density="compact" type="error" variant="tonal">{{ error }}</v-alert>
        <v-btn color="primary" type="submit">
          <FeatherIcon aria-hidden="true" size="18" type="upload-cloud" />
          <span class="ml-2">Upload as draft</span>
        </v-btn>
        <v-progress-linear v-if="props.progress !== null" color="primary" :model-value="props.progress">
          <template #default>{{ props.progress }}%</template>
        </v-progress-linear>
      </form>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.upload-form {
  display: grid;
  gap: 1rem;
}
</style>
