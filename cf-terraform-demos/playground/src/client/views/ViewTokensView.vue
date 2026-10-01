<script setup lang="ts">
import { computed, ref } from 'vue';
import { findTask } from '../../tasks';
import PanelPage from '../components/PanelPage.vue';
import { TOKEN_EXAMPLES, type TokenExample } from '../features/view-tokens/examples';
import { contextWindowUsage, MAX_INPUT_CHARACTERS } from '../features/view-tokens/tokenization';
import { findTokenizer, TOKENIZER_DESCRIPTORS } from '../features/view-tokens/tokenizers';
import TokenSequence from '../features/view-tokens/TokenSequence.vue';
import TokenTable from '../features/view-tokens/TokenTable.vue';
import { useTokenization } from '../features/view-tokens/useTokenization';

const task = computed(() => findTask('view-tokens'));

const { input, tokenizerId, result, pending, error, visibleTokens, hiddenTokenCount } =
  useTokenization();

/**
 * Whether spaces, tabs, and newlines are drawn as visible marks.
 *
 * On by default. Whitespace is where tokenization is least intuitive — a leading space usually
 * belongs to the following word's token — so hiding it by default would conceal the panel's most
 * instructive detail behind a toggle nobody finds.
 */
const showWhitespace = ref(true);

/**
 * Whether the full token table is shown.
 *
 * Off by default: the table is exhaustive and long, and most visitors want the sequence first. It
 * is a disclosure rather than a tab so the sequence stays on screen beside it.
 */
const showTable = ref(false);

/**
 * The selected tokenizer's descriptor.
 */
const tokenizer = computed(() => findTokenizer(tokenizerId.value));

/**
 * Proportion of the reference model's context window this input would occupy.
 */
const contextUsage = computed(() =>
  contextWindowUsage(result.value?.summary.tokenCount ?? 0, tokenizer.value?.referenceContextWindow)
);

/**
 * Loads a prepared example into the editor.
 *
 * @param example The example to load.
 * @returns Nothing; the editor content is replaced and tokenization re-runs through the watcher.
 */
function loadExample(example: TokenExample): void {
  input.value = example.text;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <div class="view-tokens">
      <section class="controls" aria-labelledby="input-heading">
        <h2 id="input-heading" class="section-heading">Your text</h2>

        <label class="field-label" for="token-input">Text to tokenize</label>
        <textarea
          id="token-input"
          v-model="input"
          class="token-input"
          rows="6"
          spellcheck="false"
          :maxlength="MAX_INPUT_CHARACTERS"
          placeholder="Type or paste anything — it never leaves your browser."
        ></textarea>

        <div class="example-group" role="group" aria-labelledby="examples-heading">
          <h3 id="examples-heading" class="field-label">Or try an example</h3>
          <div class="examples">
            <button
              v-for="example in TOKEN_EXAMPLES"
              :key="example.id"
              type="button"
              class="example-button"
              :data-example="example.id"
              :title="example.teaches"
              @click="loadExample(example)"
            >
              {{ example.label }}
            </button>
          </div>
        </div>

        <div class="options">
          <div class="option">
            <label class="field-label" for="tokenizer-select">Tokenizer</label>
            <select id="tokenizer-select" v-model="tokenizerId" class="tokenizer-select">
              <option
                v-for="candidate in TOKENIZER_DESCRIPTORS"
                :key="candidate.id"
                :value="candidate.id"
              >
                {{ candidate.name }} — {{ candidate.usedBy }}
              </option>
            </select>
          </div>

          <label class="checkbox">
            <input v-model="showWhitespace" type="checkbox" />
            <span>Show whitespace</span>
          </label>

          <label class="checkbox">
            <input v-model="showTable" type="checkbox" />
            <span>Show token table</span>
          </label>
        </div>

        <!--
          The approximation disclosure sits beside the selector rather than in a footnote. A token
          count presented without saying which tokenizer produced it, and whether that tokenizer
          is the model's real one, is a number people will quote.
        -->
        <p v-if="tokenizer" class="tokenizer-note">
          <template v-if="tokenizer.fidelity === 'exact'">
            Exact counts for {{ tokenizer.usedBy }}. Other model families use different tokenizers
            and will give different counts for the same text.
          </template>
          <template v-else>
            Indicative only: this is a similar encoding, not the one {{ tokenizer.usedBy }}
            actually uses.
          </template>
          Vocabulary: {{ tokenizer.vocabularySize.toLocaleString() }} entries.
        </p>
      </section>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section v-if="result" class="results" aria-labelledby="results-heading">
        <h2 id="results-heading" class="section-heading">Tokens</h2>

        <!--
          `aria-live` so a screen-reader user hears the counts change as they type, rather than
          having to go looking for them after every edit. `polite` because an interruption on
          every keystroke would be unusable.
        -->
        <dl class="summary" aria-live="polite">
          <div class="summary-item">
            <dt>Tokens</dt>
            <dd class="summary-value">{{ result.summary.tokenCount.toLocaleString() }}</dd>
          </div>
          <div class="summary-item">
            <dt>Characters</dt>
            <dd class="summary-value">{{ result.summary.characterCount.toLocaleString() }}</dd>
          </div>
          <div class="summary-item">
            <dt>Words</dt>
            <dd class="summary-value">{{ result.summary.wordCount.toLocaleString() }}</dd>
          </div>
          <div class="summary-item">
            <dt>Characters per token</dt>
            <dd class="summary-value">{{ result.summary.charactersPerToken }}</dd>
          </div>
          <div v-if="contextUsage !== undefined && tokenizer" class="summary-item">
            <dt>Of a {{ tokenizer.referenceContextWindow.toLocaleString() }}-token window</dt>
            <dd class="summary-value">{{ contextUsage }}%</dd>
          </div>
        </dl>

        <p v-if="result.truncatedCharacters > 0" class="notice" role="status">
          Only the first {{ MAX_INPUT_CHARACTERS.toLocaleString() }} characters were tokenized;
          {{ result.truncatedCharacters.toLocaleString() }} more were left out. Tokenizing runs in
          this tab, so a very long input would freeze the page.
        </p>

        <div class="sequence-area" :class="{ 'sequence-area--stale': pending }">
          <TokenSequence
            :tokens="visibleTokens"
            :total-tokens="result.summary.tokenCount"
            :show-whitespace="showWhitespace"
          />
        </div>

        <p v-if="hiddenTokenCount > 0" class="notice" role="status">
          Showing the first {{ visibleTokens.length.toLocaleString() }} tokens.
          {{ hiddenTokenCount.toLocaleString() }} more are counted above but not drawn.
        </p>

        <div v-if="showTable" class="table-area">
          <TokenTable :tokens="visibleTokens" />
        </div>
      </section>

      <section class="explainer" aria-labelledby="explainer-heading">
        <h2 id="explainer-heading" class="section-heading">Why this panel costs nothing</h2>
        <p>
          Tokenization is arithmetic over a lookup table, not a model call. The encodings are
          bundled with this page and run on your machine, so your text is never sent anywhere, no AI
          Gateway log is created, and nothing is charged. That is also why this panel is not listed
          as a gateway exception: there is no request to route.
        </p>
        <p>
          Every other panel here does call a model, and each of those requests goes through AI
          Gateway and appears in the session cost meter.
        </p>
      </section>
    </div>
  </PanelPage>
</template>

<style scoped>
.view-tokens {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.token-input {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface));
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.875rem;
  padding: 0.75rem;
  resize: vertical;
  width: 100%;
}

.token-input:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}

.example-group {
  margin-top: 1rem;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.example-button {
  background-color: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  /* Comfortably above the minimum target size for a pointer or a touch. */
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.example-button:hover,
.example-button:focus-visible {
  border-color: rgb(var(--v-theme-primary));
}

.options {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  margin-top: 1rem;
}

.tokenizer-select {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  min-height: 2.25rem;
  padding: 0.375rem 0.5rem;
}

.checkbox {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  min-height: 2.25rem;
}

.tokenizer-note {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.75rem 0 0;
  max-width: 44rem;
}

.summary {
  display: grid;
  gap: 0.5rem 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  margin: 0 0 1rem;
}

.summary-item dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.summary-value {
  font-size: 1.375rem;
  font-weight: 700;
  margin: 0;
}

.sequence-area {
  transition: opacity 120ms ease-out;
}

/*
  A stale result fades rather than disappearing. Blanking the sequence on every keystroke would
  flash the whole panel; dimming says "recalculating" without taking the answer away.
*/
.sequence-area--stale {
  opacity: 0.55;
}

.table-area {
  margin-top: 1.5rem;
}

.notice {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.75rem 0 0;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.explainer {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  max-width: 44rem;
  padding-top: 1.25rem;
}

.explainer p {
  margin: 0 0 0.75rem;
}

.explainer p:last-child {
  margin-bottom: 0;
}
</style>
