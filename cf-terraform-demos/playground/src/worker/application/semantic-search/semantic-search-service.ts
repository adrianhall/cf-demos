/**
 * @file The Semantic Search use case. This service orchestrates the only panel in the demo whose
 *   **number of paid calls is not a function of its input**, and that single fact shapes everything
 *   here. **Two strategies, two entirely different shapes of work.** An embedding model is asked
 *   for vectors — the query's, plus one per passage not already cached — and this service then
 *   computes the ranking locally, for free. A cross-encoder is asked for the ranking itself in a
 *   single call, and nothing it returns can be reused. The branch between them is read from the
 *   reviewed descriptor rather than from a model identifier, so adding a fourth embedding model
 *   needs no change here at all. **A cached search costs nothing, and that is reported as nothing
 *   rather than as unknown.** If every passage and the query itself are already embedded, the run
 *   makes zero gateway calls, has zero log identifiers, and is `not-applicable` rather than
 *   `unavailable`. Those two look similar and mean opposite things: `unavailable` is "we could not
 *   measure this", while `not-applicable` is "there was nothing to measure". Conflating them would
 *   make the session meter untrustworthy in precisely the case this panel exists to demonstrate.
 *   **The calls are sequential, as in Translate Text.** Embedding the query and the collection
 *   concurrently would be marginally faster and materially worse: each is separately billed, so a
 *   failure partway through a parallel fan-out leaves an unknown number of paid calls in flight
 *   with no way to report what was spent. Sequential calls mean a failure has a known cost.
 *   **Nothing the visitor typed is logged, and nothing is stored but vectors.** The cache is keyed
 *   by a hash of the text rather than by the text, so even the one component that persists between
 *   requests holds no copy of the collection.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { RunReceipt } from '../../../shared/runs';
import type {
  AppliedSemanticSearchControls,
  RankedPassage,
  SemanticSearchResult,
  VectorSummary
} from '../../../shared/semantic-search';
import {
  assignRanks,
  rankByCosineSimilarity,
  readEmbeddings,
  readRerankerScores,
  summariseVector,
  type EmbeddingRejection,
  type RerankerRejection
} from '../../domain/embedding-normalisation';
import { initialCostStatus } from '../../domain/metrics';
import {
  buildEmbeddingInput,
  buildRerankerInput,
  describeAppliedSemanticSearchControls,
  effectiveTopK,
  type ValidatedSemanticSearchRequest
} from '../../domain/semantic-search';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { EmbeddingCachePort } from '../ports/embedding-cache-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Semantic Search run produced.
 */
export interface SemanticSearchServiceResult {
  /**
   * The ranking, its vector disclosure, and what the search cost in model calls.
   */
  result: SemanticSearchResult;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the search was produced with.
   */
  applied: AppliedSemanticSearchControls;
}

/**
 * Dependencies of {@link SemanticSearchService}.
 */
export interface SemanticSearchServiceOptions {
  /**
   * Gateway-routed inference, injected by the Worker's composition root.
   */
  inference: InferencePort;
  /**
   * Where run records are kept until their metrics are read.
   */
  runs: RunRepositoryPort;
  /**
   * Where already-computed embeddings are reused from.
   */
  embeddings: EmbeddingCachePort;
  /**
   * Clock reading epoch milliseconds. Injected so a test can assert on timing without waiting.
   */
  now?: () => number;
  /**
   * Where an unusable provider output is recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Searches a collection through AI Gateway.
 */
export class SemanticSearchService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #embeddings: EmbeddingCachePort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, embedding cache, and optional clock and logger;
   *   see {@link SemanticSearchServiceOptions}.
   */
  constructor(options: SemanticSearchServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#embeddings = options.embeddings;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one search.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The ranking, receipt, and applied controls; see
   * {@link SemanticSearchServiceResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable ranking in the shape its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async search(
    request: ValidatedSemanticSearchRequest,
    actor: VerifiedActor
  ): Promise<SemanticSearchServiceResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const strategy = request.model.semanticSearchControls?.strategy ?? 'embedding';

    const { result, logIds } =
      strategy === 'cross-encoder'
        ? await this.#rerank(request, actor)
        : await this.#embedAndRank(request, actor);

    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'semantic-search',
      model: request.model.id,
      gatewayRouted: true,
      logIds,
      status: 'completed',
      // A fully cached search made no calls at all, so there is genuinely nothing to cost. That
      // is `not-applicable`, never `unavailable` — the latter would claim a measurement failed
      // when none was ever needed, and this panel's whole point is that the second search is
      // free.
      costStatus:
        result.usage.inferenceCallCount === 0 ? 'not-applicable' : initialCostStatus(logIds),
      elapsedMs: this.#now() - startedAtMs,
      startedAt
    };

    await this.#runs.save({
      runId: receipt.runId,
      task: receipt.task,
      model: receipt.model,
      ownerEmail: actor.email,
      logIds,
      status: receipt.status,
      startedAtMs
    });

    return {
      result,
      receipt,
      applied: describeAppliedSemanticSearchControls(request)
    };
  }

  /**
   * Embeds whatever is not already cached, then ranks locally.
   *
   * The query and the uncached passages are fetched in separate calls rather than one combined
   * request, because they are cached independently: a repeat of the same query over an edited
   * collection should pay only for the new passage, and a new query over a known collection should
   * pay only for the query.
   *
   * @param request The validated request.
   * @param actor The verified identity the calls are attributed to.
   * @returns The ranking and the gateway log identifiers the calls produced.
   * @throws {ProblemDetailsError} `502` when a response carries no usable vectors.
   */
  async #embedAndRank(
    request: ValidatedSemanticSearchRequest,
    actor: VerifiedActor
  ): Promise<{ result: SemanticSearchResult; logIds: string[] }> {
    const modelId = request.model.id;
    const cacheScope = actor.sub;
    const logIds: string[] = [];

    // `actor.sub` scopes the cache to one verified identity. Reusing a vector across visitors
    // would reveal that another person submitted byte-identical content through the presence of a
    // cache hit, even though the content itself was never displayed.
    const cachedQuery = await this.#embeddings.get(cacheScope, modelId, request.query);
    let queryVector = cachedQuery;

    if (queryVector === undefined) {
      queryVector = await this.#embedBatch(request, actor, [request.query], logIds, 'query');
      await this.#embeddings.set(cacheScope, modelId, request.query, queryVector);
    }

    // Resolved before any call, so the single batched request covers exactly the passages that
    // are missing. Their positions are kept because the vectors come back positionally.
    const cachedFlags: boolean[] = [];
    const missingIndices: number[] = [];
    const passageVectors: (readonly number[] | undefined)[] = [];

    for (const [index, passage] of request.passages.entries()) {
      const cached = await this.#embeddings.get(cacheScope, modelId, passage);
      passageVectors.push(cached);
      cachedFlags.push(cached !== undefined);
      if (cached === undefined) {
        missingIndices.push(index);
      }
    }

    if (missingIndices.length > 0) {
      const texts = missingIndices.map((index) => request.passages[index] ?? '');
      const fresh = await this.#embedBatchMany(request, actor, texts, logIds);

      for (const [position, index] of missingIndices.entries()) {
        const vector = fresh[position];
        if (vector === undefined) {
          // Unreachable: `readEmbeddings` already enforces the cardinality. Guarded anyway rather
          // than coerced to an empty vector, which would silently rank that passage at zero.
          throw searchFailure('wrong_cardinality');
        }
        passageVectors[index] = vector;
        await this.#embeddings.set(cacheScope, modelId, request.passages[index] ?? '', vector);
      }
    }

    const resolved = passageVectors.map((vector) => {
      if (vector === undefined) {
        throw searchFailure('wrong_cardinality');
      }
      return vector;
    });

    const dimensionMismatch = resolved.some((vector) => vector.length !== queryVector.length);
    if (dimensionMismatch) {
      // Reachable in one real situation: a cached vector from an earlier contract version of the
      // same model identifier. Refusing beats ranking across incompatible spaces, which would
      // produce a confident and meaningless ordering.
      this.#logger?.error('semantic_search_output_unusable', {
        reason: 'inconsistent_dimensions',
        model: modelId,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        queryDimensions: queryVector.length,
        declaredDimensions: request.model.semanticSearchControls?.dimensions ?? null
      });
      throw searchFailure('inconsistent_dimensions');
    }

    const ranked = rankByCosineSimilarity(queryVector, resolved, cachedFlags);
    const cachedPassageCount = cachedFlags.filter(Boolean).length;

    return {
      logIds,
      result: this.#present(request, ranked, summariseVector(queryVector), {
        inferenceCallCount: logIds.length,
        embeddedPassageCount: missingIndices.length,
        cachedPassageCount,
        queryEmbedded: cachedQuery === undefined
      })
    };
  }

  /**
   * Embeds one batch and returns the first vector.
   *
   * @param request The validated request, for the model descriptor and run identifier.
   * @param actor The verified identity the call is attributed to.
   * @param texts The texts to embed.
   * @param logIds Collector the call's gateway log identifier is appended to.
   * @param label What is being embedded, recorded in a diagnostic.
   * @returns The first vector of the response.
   * @throws {ProblemDetailsError} `502` when the response carries no usable vector.
   */
  async #embedBatch(
    request: ValidatedSemanticSearchRequest,
    actor: VerifiedActor,
    texts: readonly string[],
    logIds: string[],
    label: string
  ): Promise<readonly number[]> {
    const vectors = await this.#embedBatchMany(request, actor, texts, logIds, label);
    const first = vectors[0];
    if (first === undefined) {
      throw searchFailure('wrong_cardinality');
    }
    return first;
  }

  /**
   * Embeds one batch of texts in a single gateway call.
   *
   * @param request The validated request, for the model descriptor and run identifier.
   * @param actor The verified identity the call is attributed to.
   * @param texts The texts to embed, whose order the returned vectors follow.
   * @param logIds Collector the call's gateway log identifier is appended to.
   * @param label What is being embedded, recorded in a diagnostic.
   * @returns One vector per submitted text, in the same order.
   * @throws {ProblemDetailsError} `502` when the response carries no usable vectors.
   */
  async #embedBatchMany(
    request: ValidatedSemanticSearchRequest,
    actor: VerifiedActor,
    texts: readonly string[],
    logIds: string[],
    label = 'passages'
  ): Promise<number[][]> {
    const call = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'semantic-search',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildEmbeddingInput(texts)
    });

    if (call.logId !== undefined) {
      logIds.push(call.logId);
    }

    const read = readEmbeddings(call.output, texts.length);

    if (!read.ok) {
      // Counts and keys only, never values: a value here would be the visitor's own text, and a
      // vector is derived directly from it.
      this.#logger?.error('semantic_search_output_unusable', {
        reason: read.reason,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        embedding: label,
        expectedVectors: texts.length,
        declaredDimensions: request.model.semanticSearchControls?.dimensions ?? null,
        outputType: call.output === null ? 'null' : typeof call.output,
        outputKeys:
          typeof call.output === 'object' && call.output !== null && !Array.isArray(call.output)
            ? Object.keys(call.output as Record<string, unknown>)
            : []
      });

      throw searchFailure(read.reason);
    }

    return read.vectors;
  }

  /**
   * Scores the collection with a cross-encoder in one call.
   *
   * No cache is consulted and none is written. A cross-encoder's score describes a query/passage
   * _pair_, so it is invalidated by the next query and there is nothing a later search could reuse
   * — which is the cost difference this panel exists to show.
   *
   * @param request The validated request.
   * @param actor The verified identity the call is attributed to.
   * @returns The ranking and the gateway log identifier the call produced.
   * @throws {ProblemDetailsError} `502` when the response carries no usable scores.
   */
  async #rerank(
    request: ValidatedSemanticSearchRequest,
    actor: VerifiedActor
  ): Promise<{ result: SemanticSearchResult; logIds: string[] }> {
    const call = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'semantic-search',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildRerankerInput(request.query, request.passages, effectiveTopK(request))
    });

    const logIds = call.logId === undefined ? [] : [call.logId];
    const read = readRerankerScores(call.output, request.passages.length);

    if (!read.ok) {
      this.#logger?.error('semantic_search_output_unusable', {
        reason: read.reason,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        strategy: 'cross-encoder',
        passageCount: request.passages.length,
        outputType: call.output === null ? 'null' : typeof call.output,
        outputKeys:
          typeof call.output === 'object' && call.output !== null && !Array.isArray(call.output)
            ? Object.keys(call.output as Record<string, unknown>)
            : []
      });

      throw searchFailure(read.reason);
    }

    // A reranker may legitimately return fewer entries than passages when asked to, so a short
    // list is reported rather than refused. The panel shows the ranked total beside the shown
    // count, so a visitor sees that some passages were not scored.
    if (read.scores.length < request.passages.length) {
      this.#logger?.warn('semantic_search_passages_unscored', {
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        submitted: request.passages.length,
        scored: read.scores.length
      });
    }

    const ranked = assignRanks(
      read.scores.map((entry) => ({ index: entry.index, score: entry.score, cached: false }))
    );

    return {
      logIds,
      result: this.#present(request, ranked, undefined, {
        inferenceCallCount: logIds.length,
        // A cross-encoder embeds nothing and caches nothing, so both counts are zero rather than
        // being made to look like a fully-uncached embedding run.
        embeddedPassageCount: 0,
        cachedPassageCount: 0,
        queryEmbedded: false
      })
    };
  }

  /**
   * Applies the result count and assembles the presented outcome.
   *
   * Embedding-model rankings are truncated here because the model only produced vectors and has no
   * result-count control. The cross-encoder receives `top_k` itself, so its returned list is
   * already truncated and this second slice is harmless defence in depth. In both cases
   * `totalRanked` remains a fact about what the response actually contained rather than a
   * restatement of what was asked for.
   *
   * @param request The validated request, for the result count.
   * @param ranked Every passage that was scored, already ordered best-first.
   * @param queryVector The query's vector disclosure, absent for a cross-encoder.
   * @param usage What the search cost in model calls.
   * @returns The presented result.
   */
  #present(
    request: ValidatedSemanticSearchRequest,
    ranked: readonly RankedPassage[],
    queryVector: VectorSummary | undefined,
    usage: SemanticSearchResult['usage']
  ): SemanticSearchResult {
    const strategy = request.model.semanticSearchControls?.strategy ?? 'embedding';

    return {
      strategy,
      rankings: ranked.slice(0, effectiveTopK(request)),
      totalRanked: ranked.length,
      ...(queryVector === undefined ? {} : { queryVector }),
      usage
    };
  }
}

/**
 * Builds the sanitised error returned when a search cannot be produced or trusted.
 *
 * The detail differs by cause because the useful advice differs. A cardinality or dimension
 * mismatch is a contract change that retrying cannot fix, while an unreadable envelope might be a
 * transient provider fault.
 *
 * @param reason Why normalisation refused the output.
 * @returns A `502` problem-details error.
 */
function searchFailure(reason: EmbeddingRejection | RerankerRejection): ProblemDetailsError {
  const detail =
    reason === 'wrong_cardinality'
      ? 'The model returned a different number of vectors than passages were submitted, so each '
        + 'score would describe the wrong passage. This application will not guess at the '
        + 'alignment.'
      : reason === 'inconsistent_dimensions'
        ? 'The model returned vectors of differing sizes, which cannot be compared against each '
          + 'other. This is a fault in the service rather than in your collection.'
        : reason === 'malformed_vector'
          ? 'The model returned an embedding this application could not read as a list of '
            + 'numbers. Try a different model for this panel.'
          : reason === 'index_out_of_range'
            ? 'The model scored a passage that was not part of the collection, so its ranking '
              + 'cannot be trusted. This is a fault in the service rather than in your request.'
            : reason === 'no_usable_scores'
              ? 'The model returned no scores this application could read. Try a different model '
                + 'for this panel.'
              : 'The model did not answer in the shape its contract describes. This is a fault in '
                + 'the service rather than in your request, and retrying is unlikely to help.';

  return new ProblemDetailsError({
    status: 502,
    title: 'The collection could not be searched',
    detail
  });
}
