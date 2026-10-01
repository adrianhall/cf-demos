<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useHandoffStore } from '../../stores/handoff';
import {
  downloadFileName,
  downloadLabel,
  formatBytes,
  imageAltText,
  toDataUri,
  type GalleryEntry
} from './gallery';

defineProps<{
  /**
   * Generated results, newest first.
   */
  entries: GalleryEntry[];
}>();

const router = useRouter();
const handoff = useHandoffStore();

/**
 * Sends a generated image to the Describe Image panel.
 *
 * The bytes travel through a store rather than the URL. A route parameter would put several
 * megabytes of base64 into browser history and into any intermediary's logs, which is exactly what
 * this demo refuses to do with a prompt.
 *
 * The pairing is more than a convenience. The alt text here can only say what the image was asked
 * to be, because nothing has looked at it; Describe Image is the panel that can say what it
 * actually is. Moving one result between the two is the shortest demonstration of the difference.
 *
 * @param entry The result to hand over.
 * @returns A promise fulfilled once the other panel has been navigated to.
 */
async function describeThis(entry: GalleryEntry): Promise<void> {
  handoff.offer({
    base64: entry.image.base64,
    mediaType: entry.image.mediaType,
    byteLength: entry.image.byteLength,
    origin: `Generated in Create Image (${entry.modelName})`
  });

  await router.push('/describe-image');
}
</script>

<template>
  <section v-if="entries.length > 0" class="gallery" aria-labelledby="gallery-heading">
    <h2 id="gallery-heading" class="section-heading">Results</h2>
    <!--
      Scoped to what this application does, which is a claim it can actually keep: no R2 bucket, no
      database, nothing persisted (an architecture test fails the build if a storage binding is
      added). It says "this demo stores no copy" rather than "nothing is stored anywhere", because
      the latter would be a statement about AI Gateway's retention that this application is in no
      position to make.
    -->
    <p class="gallery-note">
      Newest first. Images are held in this browser tab only — this demo keeps no copy, so they are
      gone when you reload.
    </p>

    <ol class="results">
      <li v-for="entry in entries" :key="entry.runId" class="result">
        <!--
          The alt text names the prompt the image was generated from rather than asserting what the
          picture contains: nothing here has looked at the image, and a diffusion model frequently
          does not produce what was asked for. Claiming otherwise would be a confident lie to the
          one user who cannot check it.
        -->
        <img
          class="result-image"
          :src="toDataUri(entry.image)"
          :alt="imageAltText(entry)"
          :width="entry.applied.width"
          :height="entry.applied.height"
        />

        <div class="result-body">
          <p class="result-prompt">{{ entry.applied.prompt }}</p>
          <p v-if="entry.applied.negativePrompt" class="result-negative">
            Avoiding: {{ entry.applied.negativePrompt }}
          </p>

          <!--
            The settings are listed per result, which is what makes the gallery a comparison tool
            rather than a scrapbook: two images of the same prompt at different step counts are only
            informative if you can see which was which.
          -->
          <dl class="result-settings">
            <div class="setting">
              <dt>Model</dt>
              <dd>{{ entry.modelName }}</dd>
            </div>
            <div v-if="entry.applied.steps !== undefined" class="setting">
              <dt>Steps</dt>
              <dd>{{ entry.applied.steps }}</dd>
            </div>
            <div v-if="entry.applied.width !== undefined" class="setting">
              <dt>Size</dt>
              <dd>{{ entry.applied.width }} × {{ entry.applied.height }}</dd>
            </div>
            <div v-if="entry.applied.guidance !== undefined" class="setting">
              <dt>Guidance</dt>
              <dd>{{ entry.applied.guidance }}</dd>
            </div>
            <div v-if="entry.applied.seed !== undefined" class="setting">
              <dt>Seed</dt>
              <dd>{{ entry.applied.seed }}</dd>
            </div>
            <div class="setting">
              <dt>File</dt>
              <dd>
                {{ entry.image.mediaType.replace('image/', '').toUpperCase() }},
                {{ formatBytes(entry.image.byteLength) }}
              </dd>
            </div>
          </dl>

          <!--
            `download` with an explicit file name whose extension follows the server's byte-level
            sniff, so a saved file's name always agrees with its actual contents. The accessible
            label names the format, because "Download" alone does not say what is about to be saved.
          -->
          <div class="result-actions">
            <a
              class="download"
              :href="toDataUri(entry.image)"
              :download="downloadFileName(entry)"
              :aria-label="downloadLabel(entry)"
            >
              Download {{ entry.image.mediaType.replace('image/', '').toUpperCase() }}
            </a>

            <!--
              The honest counterpart to this gallery's alt text. Nothing here has looked at the
              picture, so the panel can only report the prompt; handing the image to a vision
              model is how a visitor finds out what was actually produced.
            -->
            <button
              type="button"
              class="describe-link"
              :data-describe="entry.runId"
              @click="describeThis(entry)"
            >
              Describe this image
            </button>
          </div>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0;
}

.gallery-note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0 0 0.5rem;
}

.results {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}

.result {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/*
  `height: auto` alongside the intrinsic width/height attributes, so the browser can reserve the
  right space before the image paints without the attributes forcing a fixed display size.
*/
.result-image {
  aspect-ratio: 1 / 1;
  background-color: rgb(var(--v-theme-surface-variant));
  display: block;
  height: auto;
  object-fit: contain;
  width: 100%;
}

.result-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1rem 1rem;
}

.result-prompt {
  margin: 0;
}

.result-negative {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

.result-settings {
  display: grid;
  gap: 0.25rem 1rem;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  margin: 0;
}

.setting dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.setting dd {
  font-size: 0.875rem;
  margin: 0;
}

.result-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

/*
  Styled as a link rather than a button because it navigates. It is a `button` element because it
  also stages state before navigating, and a bare anchor would offer a URL that does not carry the
  image.
*/
.describe-link {
  background: none;
  border: none;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
}

.download {
  align-self: flex-start;
  /* Comfortably above the minimum target size for a pointer or a touch. */
  min-height: 2.25rem;
  padding: 0.375rem 0;
}
</style>
