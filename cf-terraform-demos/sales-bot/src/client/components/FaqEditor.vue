<script setup lang="ts">
import { computed, ref } from 'vue';
import { AUDIENCES, type Audience } from '../../worker/domain/audience';
import type { Product } from '../../worker/domain/product';
import type { FaqDraft } from '../stores';

const props = defineProps<{
  /**
   * Products offered in the selector, loaded from the server map.
   */
  products: Product[];
  /**
   * Whether a request is in flight, which disables submission.
   */
  busy: boolean;
}>();

const emit = defineEmits<{
  /**
   * Publish the composed draft.
   */
  publish: [draft: FaqDraft];
}>();

const question = ref('');
const answer = ref('');
const productId = ref('');
const audience = ref<Audience>('internal');

/**
 * How the expiry is chosen.
 *
 * Three options rather than a date field that may be left blank, because "use the 90-day default"
 * and "this answer does not go stale" are genuinely different intentions and a blank field cannot
 * express both. The server makes the same distinction.
 */
const expiryMode = ref<'default' | 'date' | 'none'>('default');
const expiryDate = ref('');

/**
 * Whether the form is complete enough to submit.
 *
 * Only presence is checked here. Length bounds and every other rule are enforced by the server,
 * which is the copy that matters; duplicating them in the browser would mean two sets of limits to
 * keep in step.
 */
const submittable = computed(
  () =>
    question.value.trim().length > 0
    && answer.value.trim().length > 0
    && (expiryMode.value !== 'date' || expiryDate.value.length > 0)
);

/**
 * Build the draft's expiry field from the selected mode.
 *
 * @returns An object to spread into the draft: empty for the default, or carrying `expiresAt` when
 *   the author chose a date or removed the expiry.
 */
function expiryFields(): Pick<FaqDraft, 'expiresAt'> | Record<string, never> {
  if (expiryMode.value === 'default') {
    return {};
  }
  if (expiryMode.value === 'none') {
    return { expiresAt: null };
  }
  return { expiresAt: new Date(`${expiryDate.value}T00:00:00Z`).toISOString() };
}

/**
 * Emit the composed draft and reset the form.
 *
 * The form is cleared optimistically: the parent announces any failure in its own live region, and
 * keeping a stale draft on screen after a successful publish would invite a duplicate.
 *
 * @returns Nothing; it emits `publish` with the composed draft.
 */
function submit(): void {
  emit('publish', {
    question: question.value.trim(),
    answer: answer.value.trim(),
    productId: productId.value === '' ? null : productId.value,
    audience: audience.value,
    ...expiryFields()
  });
  question.value = '';
  answer.value = '';
}
</script>

<template>
  <form class="editor" @submit.prevent="submit">
    <h2 id="editor-heading">Publish an FAQ</h2>
    <div class="field">
      <label for="faq-question">Question</label>
      <input id="faq-question" v-model="question" type="text" required maxlength="500" />
    </div>
    <div class="field">
      <label for="faq-answer">Answer</label>
      <textarea id="faq-answer" v-model="answer" required maxlength="8000" rows="5"></textarea>
    </div>
    <div class="row">
      <div class="field">
        <label for="faq-product">Product</label>
        <select id="faq-product" v-model="productId">
          <option value="">All products</option>
          <option v-for="product in props.products" :key="product.id" :value="product.id">
            {{ product.name }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="faq-audience">Audience</label>
        <select id="faq-audience" v-model="audience">
          <option v-for="value in AUDIENCES" :key="value" :value="value">{{ value }}</option>
        </select>
      </div>
    </div>
    <fieldset class="field">
      <legend>Expiry</legend>
      <label class="choice">
        <input v-model="expiryMode" type="radio" value="default" />
        Default (90 days)
      </label>
      <label class="choice">
        <input v-model="expiryMode" type="radio" value="date" />
        Choose a date
      </label>
      <label class="choice">
        <input v-model="expiryMode" type="radio" value="none" />
        No expiry
      </label>
      <input
        v-if="expiryMode === 'date'"
        v-model="expiryDate"
        aria-label="Expiry date"
        type="date"
      />
    </fieldset>
    <button type="submit" :disabled="!submittable || props.busy">Publish FAQ</button>
  </form>
</template>

<style scoped>
.editor {
  border: 1px solid #d0d7de;
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.row .field {
  flex: 1 1 12rem;
}
fieldset {
  border: 1px solid #d0d7de;
  border-radius: 0.5rem;
}
.choice {
  align-items: center;
  display: inline-flex;
  gap: 0.35rem;
  margin-right: 1rem;
}
label,
legend {
  font-weight: 600;
}
input,
select,
textarea {
  border: 1px solid #6b7280;
  border-radius: 0.25rem;
  font: inherit;
  padding: 0.5rem;
}
button {
  align-self: flex-start;
  background: #0051c3;
  border: 0;
  border-radius: 0.25rem;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0.5rem 1.25rem;
}
button:disabled {
  background: #6b7280;
  cursor: not-allowed;
}
</style>
