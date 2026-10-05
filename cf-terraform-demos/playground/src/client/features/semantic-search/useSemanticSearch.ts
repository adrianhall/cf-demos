/**
 * @file Stateful composable behind the Semantic Search panel: the query, the editable collection,
 *   the result count, running the search, and handing the result to {@link useRun} for cost
 *   resolution. Two things make this panel's state unlike any before it. **The collection is
 *   editable, so the panel owns a list rather than a field.** Passages are held as an array the
 *   visitor can add to, edit, and remove, and the result refers back to them by index — so a
 *   removal has to invalidate the displayed ranking rather than leave it pointing at passages that
 *   have moved. A stale ranking over an edited collection would attribute scores to the wrong text,
 *   which is worse than showing nothing. **What a search costs depends on what has already been
 *   searched, and the panel cannot know that.** The cache lives in the Worker, so the browser can
 *   state the _upper bound_ before a run and the actual figure only afterwards. It therefore says
 *   "up to two calls" in advance and reports the true count from the response, rather than
 *   predicting a number that would be wrong exactly when the cache did its job. That is the
 *   opposite of Translate Text, where the call count is a pure function of the input and can be
 *   predicted precisely.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS,
  MAX_SEMANTIC_SEARCH_PASSAGES,
  MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS,
  type AppliedSemanticSearchControls,
  type SemanticSearchRequest,
  type SemanticSearchResult
} from '../../../shared/semantic-search';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, semanticSearch } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useSemanticSearch}.
 */
export interface UseSemanticSearchOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Search transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  search?: typeof semanticSearch;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Semantic Search panel binds to.
 */
export interface UseSemanticSearchResult {
  /**
   * The query to search for.
   */
  query: Ref<string>;
  /**
   * The editable collection, in the order results refer to.
   */
  passages: Ref<string[]>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * How many results to show.
   */
  topK: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether the selected model produces reusable embeddings.
   *
   * Decides whether the panel may promise that a repeat search is free, and whether the vector
   * disclosure can appear at all.
   */
  cacheable: Ref<boolean>;
  /**
   * Whether a search is in flight.
   */
  searching: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent result, or `undefined` before a run or after the collection changed.
   */
  result: Ref<SemanticSearchResult | undefined>;
  /**
   * The query the displayed result was produced for.
   *
   * Held so the result can be labelled with the question it answers, rather than with whatever is
   * currently in the query box.
   */
  resultQuery: Ref<string>;
  /**
   * The collection the displayed result refers to, as it was at the time of the search.
   *
   * A result identifies a passage by index, so rendering it against the _current_ collection would
   * misattribute every score the moment a passage is edited or removed. This snapshot is what the
   * result table reads.
   */
  resultPassages: Ref<readonly string[]>;
  /**
   * Receipt of the most recently completed run, or `undefined`.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Resolved gateway metrics for the most recent run, or `undefined` while unresolved.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether the most recent run's cost is still being polled for.
   */
  costPending: Ref<boolean>;
  /**
   * The controls the server reported applying, or `undefined` before a run.
   */
  applied: Ref<AppliedSemanticSearchControls | undefined>;
  /**
   * How many characters the query currently holds, in code points.
   */
  queryCharacterCount: Ref<number>;
  /**
   * Whether the panel can be submitted.
   */
  canSearch: Ref<boolean>;
  /**
   * Why the panel cannot be submitted, or `null` when it can.
   */
  blockedReason: Ref<string | null>;
  /**
   * Whether another passage may be added.
   */
  canAddPassage: Ref<boolean>;
  /**
   * Adds an empty passage to the end of the collection.
   *
   * @returns Nothing; the collection has grown by one.
   */
  addPassage: () => void;
  /**
   * Removes one passage from the collection.
   *
   * @param index Position of the passage to remove.
   * @returns Nothing; the collection has shrunk and any displayed result has been discarded.
   */
  removePassage: (index: number) => void;
  /**
   * Replaces the query and the collection with a prepared example.
   *
   * @param example The query and passages to load.
   * @returns Nothing; the form holds the example and any displayed result has been discarded.
   */
  loadExample: (example: { query: string; passages: readonly string[] }) => void;
  /**
   * Searches the current collection.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  run: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Semantic Search panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseSemanticSearchOptions}.
 * @returns Reactive form state and actions; see {@link UseSemanticSearchResult}.
 */
export function useSemanticSearch(options: UseSemanticSearchOptions): UseSemanticSearchResult {
  const transport = options.search ?? semanticSearch;
  const runTracker = useRun(options.runOptions);

  const query = ref('');
  const passages = ref<string[]>(['']);
  const model = ref('');
  const topK = ref<number | undefined>(undefined);

  const searching = ref(false);
  const error = ref<string | null>(null);
  const result = shallowRef<SemanticSearchResult | undefined>(undefined);
  const resultQuery = ref('');
  const resultPassages = shallowRef<readonly string[]>([]);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedSemanticSearchControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared search controls, or `undefined` before the catalogue loads.
   */
  const controls = computed(() => selectedModel.value?.semanticSearchControls);

  const cacheable = computed(() => controls.value?.cacheable === true);

  /**
   * Discards the displayed result.
   *
   * Called whenever the collection changes, because a result identifies a passage by its index in
   * the collection it was produced against. Keeping it on screen after an edit would attribute
   * scores to passages that have moved — a wrong answer presented exactly as confidently as a right
   * one.
   *
   * @returns Nothing; the result area is empty again.
   */
  function discardResult(): void {
    result.value = undefined;
    resultPassages.value = [];
    resultQuery.value = '';
  }

  // The first reviewed model becomes the default once the catalogue arrives, so the catalogue's
  // order is the preference order and there is no second list to keep in step with it.
  watch(
    options.models,
    (available) => {
      const first = available[0];
      if (model.value === '' && first !== undefined) {
        model.value = first.id;
      }
    },
    { immediate: true }
  );

  // Switching model re-settles the result count and discards the displayed result.
  //
  // The result is discarded because scores from two models are **not comparable**: a cosine of
  // 0.73 in a 1,024-dimension space and one of 0.65 in a 768-dimension space describe unrelated
  // things. Leaving the previous model's ranking on screen under the new model's name is the
  // single most misleading thing this panel could do.
  watch(
    selectedModel,
    (current, previous) => {
      const support = current?.semanticSearchControls;
      if (support === undefined) {
        return;
      }

      topK.value = topK.value ?? support.topK.default;

      if (previous !== undefined && previous.id !== current?.id) {
        discardResult();
      }
    },
    { immediate: true }
  );

  const queryCharacterCount = computed(() => [...query.value].length);

  /**
   * The passages that would actually be searched, with blanks dropped.
   *
   * Blank rows are a normal state of an editable list — one appears the moment "Add passage" is
   * pressed — so they are filtered here rather than refused. The server does refuse them, but it
   * never sees them: a blank row is a half-finished edit, not a request to search for nothing.
   */
  const filledPassages = computed(() =>
    passages.value.map((passage) => passage.trim()).filter((passage) => passage !== '')
  );

  const canAddPassage = computed(() => passages.value.length < MAX_SEMANTIC_SEARCH_PASSAGES);

  // A result identifies passages by their position in the collection that was submitted. Watch the
  // full array rather than only its length, so changing one character invalidates it too; otherwise
  // a score could be rendered beside text whose embedding it never described.
  watch(passages, discardResult, { deep: true });

  const blockedReason = computed(() => {
    if (queryCharacterCount.value > MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS) {
      return (
        `That query is ${queryCharacterCount.value.toLocaleString()} characters, and this panel `
        + `searches with up to ${MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS.toLocaleString()}. A query `
        + 'is a question rather than a document.'
      );
    }

    const overlong = passages.value.findIndex(
      (passage) => [...passage].length > MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS
    );

    if (overlong !== -1) {
      return (
        `Passage ${overlong + 1} is longer than `
        + `${MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS.toLocaleString()} characters. A passage beyond `
        + 'the model\u2019s context window is truncated by the model, so the score would describe '
        + 'only the part it read.'
      );
    }

    if (query.value.trim() !== '' && filledPassages.value.length === 0) {
      return 'Add at least one passage to search through.';
    }

    return null;
  });

  const canSearch = computed(
    () =>
      !searching.value
      && query.value.trim() !== ''
      && filledPassages.value.length > 0
      && selectedModel.value !== undefined
      && blockedReason.value === null
  );

  return {
    query,
    passages,
    model,
    topK,
    selectedModel,
    cacheable,
    searching,
    error,
    result,
    resultQuery,
    resultPassages,
    receipt,
    metrics: runTracker.metrics,
    costPending: runTracker.costPending,
    applied,
    queryCharacterCount,
    canSearch,
    blockedReason,
    canAddPassage,
    addPassage: (): void => {
      if (passages.value.length < MAX_SEMANTIC_SEARCH_PASSAGES) {
        passages.value = [...passages.value, ''];
      }
    },
    removePassage: (index: number): void => {
      passages.value = passages.value.filter((_, position) => position !== index);
      // The last row is never removed outright, so the collection editor always has somewhere to
      // type rather than becoming an empty area with only an Add button.
      if (passages.value.length === 0) {
        passages.value = [''];
      }
      discardResult();
    },
    loadExample: (example): void => {
      query.value = example.query;
      passages.value = [...example.passages];
      discardResult();
    },
    run: async (): Promise<void> => {
      if (!canSearch.value) {
        return;
      }

      const runId = crypto.randomUUID();
      const submitted = filledPassages.value;
      const submittedQuery = query.value;

      error.value = null;
      searching.value = true;
      controller = new AbortController();

      const request: SemanticSearchRequest = {
        query: submittedQuery,
        passages: [...submitted],
        model: model.value,
        runId,
        ...(topK.value === undefined ? {} : { topK: topK.value })
      };

      try {
        const response = await transport(request, controller.signal);

        result.value = response.result;
        receipt.value = response.receipt;
        applied.value = response.applied;
        // Snapshotted together with the result, so the table renders the passages the ranking
        // actually refers to even if the editor is changed while the request is in flight.
        resultPassages.value = submitted;
        resultQuery.value = submittedQuery;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The collection could not be searched. Check your connection and try again.';
        }
      } finally {
        searching.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none.
      if (receipt.value !== undefined) {
        await runTracker.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    }
  };
}
