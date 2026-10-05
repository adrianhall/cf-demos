/**
 * @file The Semantic Search panel's wire contract. It sits in `src/shared/` beside the other
 *   panels' contracts because both tiers need it, and like them it carries no model descriptors —
 *   the browser learns which models exist and what each accepts from `/api/catalogue`. Three
 *   properties make this contract unlike every panel before it. **A run is several model calls, and
 *   the number depends on what is already cached.** Every other panel maps one user action onto a
 *   fixed number of inference requests. Here a search embeds the query and whichever passages have
 *   not been embedded before, so the same button press can cost two calls, one call, or none at
 *   all. `RunReceipt.logIds` has carried several identifiers since phase 3 and Translate Text
 *   already exercises it, but this is the first panel where the count is not predictable from the
 *   input alone — see {@link SemanticSearchUsage}. **The two reviewed strategies are different
 *   operations with different cost shapes**, which is the lesson the panel exists to teach; see
 *   {@link RetrievalStrategy}. An embedding model turns each text into a vector once, and the
 *   comparison afterwards is local arithmetic that costs nothing. A cross-encoder re-reads the
 *   query against every passage on every search, so nothing is reusable and its cost scales with
 *   collection size per query. That is the retrieve-then-rerank trade-off every production RAG
 *   system makes. **A similarity score is not a probability and not a confidence.** It is a
 *   relative ordering within one model's own vector space, and the numbers from two models are not
 *   comparable even when both look like "0.7". The contract therefore ships the dimension count and
 *   the strategy with every result so the UI can say which space a number lives in, and the panel
 *   never renders a similarity as a percentage. Nothing is stored beyond a session-scoped embedding
 *   cache that holds vectors, never text — see
 *   `src/worker/infrastructure/embeddings/memory-embedding-cache.ts`. The passages are already in
 *   the browser, and a result refers to them by index rather than echoing them back, so the
 *   response carries no second copy of the collection.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest query the panel will embed, in characters.
 *
 * A query is a question, not a document. The ceiling is well inside every reviewed model's context
 * window, so a query is never silently truncated by the model — which for a search would be the
 * worst possible failure, because the result would look entirely normal while answering a question
 * nobody asked.
 *
 * The server validates every request against it; a browser-side counter is a courtesy, never a
 * control.
 */
export const MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS = 512;

/**
 * Longest single passage the panel will embed, in characters.
 *
 * Sized so a passage stays inside the smallest reviewed model's context window. A passage beyond a
 * model's window is truncated by the model with nothing in the response to say so, and the vector
 * then describes a prefix of the passage while the UI attributes it to the whole.
 */
export const MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS = 1_000;

/**
 * Most passages one collection may contain.
 *
 * A **cost** bound rather than a size bound, and it binds differently for each strategy — which is
 * exactly the point. For an embedding model this caps the first search over a new collection, after
 * which the passages are cached and cost nothing. For a cross-encoder it caps _every_ search,
 * because a reranker re-reads the whole collection each time and has nothing to cache.
 */
export const MAX_SEMANTIC_SEARCH_PASSAGES = 12;

/**
 * How many components of a vector the panel will disclose.
 *
 * A deliberately small window onto a 1,024-dimensional object. Showing the whole vector would be
 * several pages of digits that communicate nothing, while showing none at all leaves "it becomes a
 * vector" as an unsupported claim. A handful of real components plus the dimension count and the
 * magnitude is enough to make the representation concrete.
 */
export const VECTOR_PREVIEW_COMPONENTS = 8;

/**
 * How a reviewed model decides which passage answers the query.
 *
 * The most consequential field in this contract, because the two strategies have different cost
 * shapes, different score scales, and different cacheability. A panel that treated them as
 * interchangeable "search models" would hide the one trade-off worth teaching.
 *
 * - `embedding` — a bi-encoder. Each text is independently turned into a vector, and similarity is
 *   computed locally by comparing vectors. A passage's vector does not depend on the query, so it
 *   is computed once and reused for every later search; the comparison itself reaches no model and
 *   costs nothing. This is the retrieval step that underpins semantic search and RAG.
 * - `cross-encoder` — a reranker. The model reads the query and one passage _together_ and emits a
 *   relevance score directly, with no vector in between. That joint reading is what makes it more
 *   accurate and what makes it impossible to cache: the score is a property of the pair, so a new
 *   query invalidates every score. Its cost therefore scales with collection size on every search.
 */
export type RetrievalStrategy = 'embedding' | 'cross-encoder';

/**
 * Where the result-count control is applied.
 *
 * - `model` — `top_k` is a field in the model's own request schema, so the provider truncates.
 * - `playground` — the model's schema has no such field, so this application truncates the ranking it
 *   computed.
 *
 * Published rather than hidden because it changes what the control _means_, and this panel is the
 * first in the demo where both values genuinely occur. The reranker declares `top_k`, so asking for
 * three results is a different operation from ranking everything and keeping three. Every embedding
 * model is `playground`: its schema has no ranking field at all, because the ranking does not
 * happen inside the model.
 */
export type SearchResultControlApplication = 'model' | 'playground';

/**
 * A numeric control a search model exposes, with the range the server will accept.
 *
 * Structurally identical to the other panels' equivalents and deliberately **not** shared with
 * them, in keeping with the convention the demo follows: one published contract should not change
 * because another panel's did.
 */
export interface NumericSemanticSearchRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation.
   */
  step: number;
  /**
   * Value used when the caller omits the control.
   */
  default: number;
}

/**
 * What one reviewed search model does, and how it must be asked.
 *
 * Every field was read from the model's own schema and verified against the live model with `cf ai
 * run`. A control absent from this declaration is rejected by validation rather than ignored, which
 * is the direction every other panel in this demo takes.
 */
export interface SemanticSearchControlSupport {
  /**
   * Which operation this model performs; see {@link RetrievalStrategy}.
   */
  strategy: RetrievalStrategy;
  /**
   * How many components this model's vectors have, for an `embedding` model.
   *
   * Published before any run, and the clearest single piece of evidence that **scores are not
   * comparable across models**: a 768-dimensional space and a 2,048-dimensional one are different
   * spaces, and a cosine of 0.7 in each means two unrelated things. Absent for a cross-encoder,
   * which produces no vector at all.
   */
  dimensions?: number;
  /**
   * Whether the embeddings this model produces may be reused across searches.
   *
   * **The cost-shape field.** True for a bi-encoder, whose passage vector is independent of the
   * query and therefore reusable. False for a cross-encoder, whose score describes a query/passage
   * _pair_ and is invalidated by the next query. The panel reads this to decide whether to consult
   * the cache at all, and to explain truthfully why one model's repeat search is free while the
   * other's is not.
   */
  cacheable: boolean;
  /**
   * Whether the model accepts several texts in one request.
   *
   * Verified against each live model rather than assumed: every reviewed embedding model accepts a
   * `text` array and returns one vector per element, which is what lets a whole collection be
   * embedded in a single paid call.
   */
  batchesTexts: boolean;
  /**
   * How many results to show, within the range the server will accept.
   */
  topK: NumericSemanticSearchRange;
  /**
   * Who applies {@link SemanticSearchControlSupport.topK}; see
   * {@link SearchResultControlApplication}.
   */
  appliedBy: SearchResultControlApplication;
  /**
   * Whether this model's scores collapse to a near-identical floor for everything irrelevant.
   *
   * True for the reviewed cross-encoder, whose irrelevant passages all score around `0.00004` while
   * a match scores `0.98`. Disclosed because it breaks the obvious rendering: a bar drawn
   * proportionally would make every non-match an identical empty bar, implying the model failed to
   * distinguish between them when in fact it separated them emphatically. The UI reads this to
   * explain the scale rather than to silently rescale it.
   */
  collapsesIrrelevantScores?: boolean;
  /**
   * Context window in tokens, where the model's truncation behaviour is worth disclosing.
   */
  contextWindowTokens?: number;
}

/**
 * Every control name a Semantic Search request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const SEMANTIC_SEARCH_CONTROL_NAMES = ['topK'] as const;

/**
 * One optional Semantic Search control; see {@link SEMANTIC_SEARCH_CONTROL_NAMES}.
 */
export type SemanticSearchControlName = (typeof SEMANTIC_SEARCH_CONTROL_NAMES)[number];

/**
 * What the browser posts to run one search.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * Unlike Classify Text, the caller **does** supply the corpus, and that is not an inconsistency. A
 * classifier's labels belong to the trained model, so accepting them from a caller would
 * misrepresent what a classifier is. A search engine's collection belongs to whoever is searching;
 * a search API that fixed its own corpus would be a demo of nothing. What the caller still cannot
 * supply is the _scoring rule_ — there is no field for a weighting, a similarity metric, or a
 * criterion, because that is the model's job.
 */
export interface SemanticSearchRequest {
  /**
   * The question to search for.
   */
  query: string;
  /**
   * The collection to search, in the caller's own order.
   *
   * Results refer back to this array by index rather than echoing the text, so the response carries
   * no second copy of a collection the browser already holds.
   */
  passages: string[];
  /**
   * Reviewed model identifier, which must be registered against the `semantic-search` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * How many results to show, within the selected model's declared range.
   */
  topK?: number;
}

/**
 * One passage the model ranked, as the panel presents it.
 */
export interface RankedPassage {
  /**
   * Position in the ranking, starting at 1.
   *
   * Carried explicitly rather than left to the array index, so a table, a list, and a screen reader
   * all agree on the ordinal even if a renderer re-sorts its own copy.
   */
  rank: number;
  /**
   * Position of this passage in the submitted collection, starting at 0.
   *
   * The response identifies a passage by where it was rather than by repeating its text. The
   * browser already has the collection, and sending it back would create a second copy of the
   * visitor's content for no benefit.
   */
  index: number;
  /**
   * The relevance score, as produced by the selected model's own strategy.
   *
   * For an `embedding` model this is the cosine similarity of two vectors, between -1 and 1 in
   * principle and in practice almost always positive. For a `cross-encoder` it is the model's own
   * relevance output between 0 and 1. **The two are not the same kind of number and must never be
   * compared**, which is why {@link SemanticSearchResult.strategy} travels with them.
   *
   * Reported at full precision rather than rounded for display, so the structured disclosure shows
   * the real figure and the bar is the only thing doing any rounding.
   */
  score: number;
  /**
   * Whether this passage's embedding was reused from an earlier search rather than recomputed.
   *
   * Always `false` for a cross-encoder, which has nothing to cache. Surfaced per passage rather
   * than as a run-level count alone, because "this one was free and that one was not" is the
   * clearest possible statement of the cost shape.
   */
  cached: boolean;
}

/**
 * A deliberately limited disclosure of one embedding.
 *
 * Shows that the text really did become a list of numbers, without pretending the numbers are
 * individually meaningful. No single component of an embedding has an interpretation, so a full
 * dump would invite a reading that does not exist.
 */
export interface VectorSummary {
  /**
   * How many components the vector has.
   */
  dimensions: number;
  /**
   * The first few components, at most {@link VECTOR_PREVIEW_COMPONENTS} of them.
   */
  preview: number[];
  /**
   * The vector's Euclidean magnitude.
   *
   * Worth showing because every reviewed model returns a unit vector, and that fact has a direct
   * consequence the panel explains: for unit vectors, cosine similarity, dot product, and Euclidean
   * distance all produce the **same ranking**. The choice of metric is therefore not a knob this
   * panel can honestly offer.
   */
  norm: number;
}

/**
 * How much inference one search actually required.
 *
 * Separated from the receipt because these are counts of _work_, not of cost. A run with zero
 * inference calls is genuinely free, which is a different statement from a run whose cost could not
 * be measured — and the demo refuses to let those two look alike.
 */
export interface SemanticSearchUsage {
  /**
   * How many gateway calls this search made.
   *
   * Zero when the query and every passage were already cached, which is the clearest demonstration
   * in the whole demo that an embedding is reusable.
   */
  inferenceCallCount: number;
  /**
   * How many passages had to be embedded.
   */
  embeddedPassageCount: number;
  /**
   * How many passages were served from the cache and cost nothing new.
   */
  cachedPassageCount: number;
  /**
   * Whether the query itself was embedded, rather than reused from an identical earlier search.
   */
  queryEmbedded: boolean;
}

/**
 * The outcome of one search.
 *
 * Carries the strategy and dimension count alongside the ranking, because a score is not
 * interpretable without knowing which space it came from.
 */
export interface SemanticSearchResult {
  /**
   * Which operation produced these scores; see {@link RetrievalStrategy}.
   */
  strategy: RetrievalStrategy;
  /**
   * The ranked passages, best first, already truncated to the requested count.
   */
  rankings: readonly RankedPassage[];
  /**
   * How many passages were scored before the result count was applied.
   *
   * Lets the UI say "showing 3 of 8 ranked passages" rather than implying the model returned three.
   */
  totalRanked: number;
  /**
   * A limited disclosure of the query's embedding, for an `embedding` model.
   *
   * Absent for a cross-encoder, which produces no vector — an absence that makes the difference
   * between the strategies concrete rather than merely described.
   */
  queryVector?: VectorSummary;
  /**
   * What the search cost in model calls; see {@link SemanticSearchUsage}.
   */
  usage: SemanticSearchUsage;
}

/**
 * The settings a search was produced with, echoed so the UI can describe the run honestly.
 *
 * The query and the passages are **not** echoed. They are already in the browser, and returning
 * them would create a second copy of the visitor's content in the response for no benefit.
 */
export interface AppliedSemanticSearchControls {
  /**
   * Model the search ran against.
   */
  model: string;
  /**
   * Which operation that model performs.
   */
  strategy: RetrievalStrategy;
  /**
   * Result count applied, whether by the model or by this application.
   */
  topK: number;
  /**
   * Who applied that count; see {@link SearchResultControlApplication}.
   */
  appliedBy: SearchResultControlApplication;
  /**
   * How many passages the collection contained.
   */
  passageCount: number;
  /**
   * Length of the query in characters, recorded instead of the query itself.
   */
  queryCharacterCount: number;
}

/**
 * What `POST /api/semantic-search` returns.
 */
export interface SemanticSearchResponse {
  /**
   * The ranking and its vector disclosure.
   */
  result: SemanticSearchResult;
  /**
   * The run receipt, carrying one log identifier per gateway call the search made.
   */
  receipt: RunReceipt;
  /**
   * The settings the search was produced with.
   */
  applied: AppliedSemanticSearchControls;
}
