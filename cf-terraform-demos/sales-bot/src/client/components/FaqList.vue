<script setup lang="ts">
import type { Audience } from '../../worker/domain/audience';
import type { Faq } from '../../worker/domain/faq';

const props = defineProps<{
  /**
   * FAQs to render.
   */
  faqs: Faq[];
  /**
   * Whether to offer the audience, expiry, and archive controls.
   */
  manageable: boolean;
  /**
   * Whether a request is in flight, which disables the controls.
   */
  busy: boolean;
}>();

const emit = defineEmits<{
  /**
   * Change one FAQ's audience.
   */
  changeAudience: [id: string, audience: Audience];
  /**
   * Remove one FAQ's expiry.
   */
  removeExpiry: [id: string];
  /**
   * Archive one FAQ.
   */
  archive: [id: string];
}>();

/**
 * Render an expiry for display.
 *
 * @param faq FAQ being rendered.
 * @returns The expiry date, or an explicit statement that there is none. Never an empty cell: a
 *   blank would be ambiguous between "no expiry" and "not loaded", and the difference matters.
 */
function expiryLabel(faq: Faq): string {
  return faq.expiresAt === null ? 'No expiry' : faq.expiresAt.slice(0, 10);
}

/**
 * Handle an audience change from the selector.
 *
 * @param faq FAQ being changed.
 * @param event Change event from the `select`.
 * @returns Nothing; it emits `changeAudience`.
 */
function onAudienceChange(faq: Faq, event: Event): void {
  emit('changeAudience', faq.id, (event.target as HTMLSelectElement).value as Audience);
}
</script>

<template>
  <p v-if="props.faqs.length === 0" class="empty">No FAQs yet.</p>
  <ul v-else class="faqs">
    <li v-for="faq in props.faqs" :key="faq.id" class="faq">
      <h3>{{ faq.question }}</h3>
      <p class="answer">{{ faq.answer }}</p>
      <!--
        Status is given as text as well as by the badge's colour. A reader who cannot distinguish
        the colours — or who is reading this through a screen reader — gets the same information.
      -->
      <p class="meta">
        <span :class="['badge', faq.status]">{{ faq.status }}</span>
        <span>Audience: {{ faq.audience }}</span>
        <span>{{ expiryLabel(faq) }}</span>
        <span>Revision {{ faq.revision }}</span>
      </p>
      <div v-if="props.manageable" class="controls">
        <label :for="`audience-${faq.id}`">Audience</label>
        <select
          :id="`audience-${faq.id}`"
          :value="faq.audience"
          :disabled="props.busy"
          @change="onAudienceChange(faq, $event)"
        >
          <option value="public">public</option>
          <option value="customer">customer</option>
          <option value="nda">nda</option>
          <option value="internal">internal</option>
        </select>
        <button
          type="button"
          :disabled="props.busy || faq.expiresAt === null"
          @click="emit('removeExpiry', faq.id)"
        >
          Remove expiry
        </button>
        <button
          type="button"
          class="danger"
          :disabled="props.busy || faq.status === 'archived'"
          @click="emit('archive', faq.id)"
        >
          Archive
        </button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.faqs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.faq {
  border: 1px solid #d0d7de;
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
}
.faq h3 {
  margin: 0 0 0.5rem;
}
.answer {
  margin: 0 0 0.75rem;
  white-space: pre-wrap;
}
.meta {
  color: #4b5563;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0;
}
.badge {
  border: 1px solid currentcolor;
  border-radius: 999px;
  font-weight: 700;
  padding: 0 0.6rem;
}
.badge.active {
  color: #116633;
}
.badge.expired {
  color: #8a5300;
}
.badge.archived {
  color: #6b7280;
}
.controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.empty {
  color: #4b5563;
}
button,
select {
  border: 1px solid #6b7280;
  border-radius: 0.25rem;
  font: inherit;
  min-height: 2.75rem;
  padding: 0.35rem 0.75rem;
}
button {
  background: #fff;
  cursor: pointer;
}
button:disabled {
  color: #6b7280;
  cursor: not-allowed;
}
.danger:not(:disabled) {
  border-color: #b42318;
  color: #b42318;
}
</style>
