/**
 * @file Semantic Search request validation and model-input construction. The rule that shapes this
 *   module is the one that separates it from Classify Text next door: **the caller supplies the
 *   corpus, but never the scoring rule.** A search engine whose collection was fixed by the server
 *   would be a demo of nothing, so `passages` is a first-class request field — unlike Classify
 *   Text, where a caller-supplied label would misrepresent what a classifier is. What a caller
 *   still cannot supply is a weighting, a similarity metric, or a relevance criterion, because
 *   deciding what is relevant is the model's job and the panel's whole subject. See
 *   {@link CALLER_DEFINED_SCORING_FIELDS}. As in every other panel, a control is validated against
 *   the selected model's declared capability rather than against a global schema, and the two
 *   reviewed strategies differ enough that this matters: the cross-encoder's `top_k` is a field in
 *   its own request schema, while an embedding model has no ranking field at all because the
 *   ranking does not happen inside it.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS,
  MAX_SEMANTIC_SEARCH_PASSAGES,
  MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS,
  type AppliedSemanticSearchControls,
  type SemanticSearchControlName
} from '../../shared/semantic-search';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Semantic Search request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input.
 */
export interface ValidatedSemanticSearchRequest {
  /**
   * The query to search for, as submitted.
   */
  query: string;
  /**
   * The collection to search, in the caller's original order.
   *
   * Order is preserved because a result refers to a passage by its index in this array. Filtering
   * blanks out of it would silently renumber every later passage and misattribute every result.
   */
  passages: readonly string[];
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Number of results to show, within the model's declared range.
   */
  topK?: number;
}

/**
 * Fields a request body must not contain.
 *
 * Identical in purpose to every other panel's list: the actor comes from the verified Access
 * identity, so a body carrying one of these is attempting to choose who the request is attributed
 * to, and is rejected rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields through which a caller might try to define their own relevance rule.
 *
 * **The regression guard that keeps this panel about retrieval rather than about ranking
 * configuration.** The whole lesson here is that an embedding model decides relevance from meaning
 * alone — no keyword list, no weighting, no boost. An API that appeared to accept a scoring rule
 * would teach the opposite, and someone who sent `weights` would reasonably believe their weighting
 * had been applied and had simply made no difference.
 *
 * `metric` is on the list for a more specific reason. Offering it would be _actively_ misleading
 * rather than merely out of scope: every reviewed model returns unit vectors, and for unit vectors
 * cosine similarity, dot product, and Euclidean distance all produce the same ranking. A metric
 * selector would be a control that demonstrably does nothing, which is worse than no control.
 *
 * The list covers plausible spellings rather than one, because this is a semantic boundary rather
 * than a schema detail.
 */
const CALLER_DEFINED_SCORING_FIELDS: readonly string[] = [
  'metric',
  'similarity',
  'similarityMetric',
  'similarity_metric',
  'distance',
  'weights',
  'weighting',
  'boost',
  'keywords',
  'criteria',
  'scoring',
  'rerank'
];

/**
 * Reads a plain object property without inheriting from the prototype chain.
 *
 * @param source Parsed JSON object.
 * @param key Property to read.
 * @returns The value, or `undefined` when the property is absent.
 */
function property(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Refuses a control the selected model does not support.
 *
 * @param control Control name, used in the error message.
 * @param model The model the control was requested against.
 * @param reason Why this model has no such control, stated so the refusal is actionable.
 * @returns Never; always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400), always.
 */
function unsupported(
  control: SemanticSearchControlName,
  model: ModelDescriptor,
  reason: string
): never {
  throw badRequest({ detail: `${model.name} does not accept "${control}". ${reason}` });
}

/**
 * Validates an untrusted Semantic Search request body.
 *
 * @param body Parsed JSON body of the request, from an untrusted caller.
 * @returns The validated request, carrying the resolved model descriptor rather than its
 *   identifier; see {@link ValidatedSemanticSearchRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not a JSON object, carries an
 *   identity field, tries to supply a caller-defined scoring rule, omits or malforms `runId`, names
 *   a model that is not reviewed for this panel, omits the query or submits a blank or over-long
 *   one, omits the collection or submits one that is empty, too large, or contains a non-string,
 *   blank, or over-long passage, or sets a result count outside the model's declared range.
 */
export function validateSemanticSearchRequest(body: unknown): ValidatedSemanticSearchRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  }

  const source = body as Record<string, unknown>;

  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The user is taken from the verified `
          + 'Cloudflare Access identity.'
      });
    }
  }

  for (const field of CALLER_DEFINED_SCORING_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". Semantic Search ranks passages by what the `
          + 'model understands them to mean, so there is no caller-defined scoring rule, keyword '
          + 'weighting, or similarity metric. Every reviewed model returns unit vectors, for '
          + 'which cosine similarity, dot product, and Euclidean distance all produce the same '
          + 'ranking.'
      });
    }
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({
      detail:
        'Request body must contain a "runId" of 8 to 64 characters, using letters, digits, '
        + 'hyphens, and underscores only.'
    });
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  }

  // Resolved against this panel specifically. Looking a model up by identifier alone is how a
  // narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('semantic-search', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Semantic Search.'
    });
  }

  const controls = model.semanticSearchControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed search controls.' });
  }

  const query = property(source, 'query');
  if (typeof query !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "query" string to search for.' });
  }

  if (query.trim() === '') {
    throw badRequest({ detail: 'Enter something to search for.' });
  }

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
  // non-BMP character counts once rather than twice.
  if ([...query].length > MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS) {
    throw badRequest({
      detail:
        `The query is longer than ${MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS} characters. Shorten it `
        + 'and search again.'
    });
  }

  const rawPassages = property(source, 'passages');
  if (!Array.isArray(rawPassages)) {
    throw badRequest({
      detail: 'Request body must contain a "passages" array holding the collection to search.'
    });
  }

  if (rawPassages.length === 0) {
    throw badRequest({ detail: 'Add at least one passage to search through.' });
  }

  if (rawPassages.length > MAX_SEMANTIC_SEARCH_PASSAGES) {
    throw badRequest({
      detail:
        `A collection may hold at most ${MAX_SEMANTIC_SEARCH_PASSAGES} passages. Each one is a `
        + 'separately billed embedding the first time it is searched, and every one of them on '
        + 'every search for a reranking model.'
    });
  }

  const passages: string[] = [];
  for (const [index, passage] of rawPassages.entries()) {
    if (typeof passage !== 'string') {
      throw badRequest({ detail: `Passage ${index + 1} must be a string.` });
    }

    // Refused rather than skipped. Dropping it would renumber every later passage, and the
    // response identifies a result by its index in the submitted collection — so a silent drop
    // would attribute every subsequent score to the wrong passage.
    if (passage.trim() === '') {
      throw badRequest({
        detail: `Passage ${index + 1} is empty. Remove it, or give it some text to search.`
      });
    }

    if ([...passage].length > MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS) {
      throw badRequest({
        detail:
          `Passage ${index + 1} is longer than ${MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS} `
          + 'characters. A passage beyond the model\u2019s context window is truncated by the '
          + 'model, which would score a prefix of it while the result claimed to describe the '
          + 'whole passage.'
      });
    }

    passages.push(passage);
  }

  const rawTopK = property(source, 'topK');
  let topK: number | undefined;

  if (rawTopK !== undefined) {
    if (typeof rawTopK !== 'number' || !Number.isInteger(rawTopK)) {
      unsupported('topK', model, 'It must be a whole number of results.');
    }

    if (rawTopK < controls.topK.min || rawTopK > controls.topK.max) {
      throw badRequest({
        detail:
          `"topK" must be between ${controls.topK.min} and ${controls.topK.max} for `
          + `${model.name}.`
      });
    }

    topK = rawTopK;
  }

  return {
    query,
    passages,
    model,
    runId,
    ...(topK === undefined ? {} : { topK })
  };
}

/**
 * Reads the effective result count for a validated request.
 *
 * @param request The validated request.
 * @returns The caller's count, or the model's declared default when they omitted it.
 */
export function effectiveTopK(request: ValidatedSemanticSearchRequest): number {
  return request.topK ?? request.model.semanticSearchControls?.topK.default ?? 1;
}

/**
 * Builds the provider request body for an embedding call.
 *
 * Every reviewed embedding model takes the same `{ text }` field and accepts an array, which was
 * verified against each live model rather than assumed. Passing an array is what lets a whole
 * collection be embedded in one paid call instead of one call per passage.
 *
 * @param texts The texts to embed, in the order their vectors are expected back.
 * @returns The provider request body.
 */
export function buildEmbeddingInput(texts: readonly string[]): Record<string, unknown> {
  return { text: [...texts] };
}

/**
 * Builds the provider request body for a cross-encoder call.
 *
 * The reranker reads the query and the passages together in one request and returns a relevance
 * score per passage, so unlike an embedding model there is nothing to cache and no vector to
 * compare. Its schema declares `top_k`, so this is the panel's genuine provider-side result-count
 * control: asking for three changes the work the model performs and the number of entries it
 * returns. The response says how many passages the model actually ranked; it never claims the
 * omitted passages were scored and then hidden.
 *
 * @param query The query to score every passage against.
 * @param passages The collection, whose array positions the response refers to by index.
 * @param topK Number of best results the provider should return. The reranker is the one reviewed
 *   model whose schema declares this as a provider-side control.
 * @returns The provider request body.
 */
export function buildRerankerInput(
  query: string,
  passages: readonly string[],
  topK: number
): Record<string, unknown> {
  return {
    query,
    contexts: passages.map((text) => ({ text })),
    top_k: topK
  };
}

/**
 * Summarises the settings a search was produced with.
 *
 * The query and the passages are deliberately absent: they are already in the browser, and echoing
 * them would create a second copy of the visitor's content for no benefit.
 *
 * @param request The validated request.
 * @returns The applied controls, for the response and the completion log.
 */
export function describeAppliedSemanticSearchControls(
  request: ValidatedSemanticSearchRequest
): AppliedSemanticSearchControls {
  const controls = request.model.semanticSearchControls;

  return {
    model: request.model.id,
    strategy: controls?.strategy ?? 'embedding',
    topK: effectiveTopK(request),
    appliedBy: controls?.appliedBy ?? 'playground',
    passageCount: request.passages.length,
    queryCharacterCount: [...request.query].length
  };
}
