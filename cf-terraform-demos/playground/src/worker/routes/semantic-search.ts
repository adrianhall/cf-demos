import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS,
  MAX_SEMANTIC_SEARCH_PASSAGES,
  MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS,
  type SemanticSearchResponse
} from '../../shared/semantic-search';
import type { AppBindings } from '../bindings';
import {
  effectiveTopK,
  validateSemanticSearchRequest,
  type ValidatedSemanticSearchRequest
} from '../domain/semantic-search';

/**
 * Largest Semantic Search request body accepted.
 *
 * Derived from the panel's own ceilings rather than chosen, so raising one of them cannot silently
 * leave this behind and turn a valid request into an opaque refusal. A full collection plus the
 * longest query, at four bytes per character for the worst UTF-8 case, with headroom for the JSON
 * structure around them.
 */
export const SEMANTIC_SEARCH_BODY_LIMIT_BYTES =
  (MAX_SEMANTIC_SEARCH_PASSAGES * MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS
    + MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS)
    * 4
  + 4_096;

/**
 * Semantic Search's endpoint, mounted at `/api/semantic-search`.
 *
 * A plain JSON `POST` rather than SSE. A ranking is a single small structured answer that is not
 * meaningful until it is complete — a partial ordering is not a useful prefix of a full one,
 * because the next score could belong at the top.
 *
 * One request here may become several gateway calls, which is unusual enough to state plainly: the
 * query and any passages not already embedded are each billed, and a repeat search over an
 * unchanged collection may make no calls at all. The response reports exactly how many calls were
 * made rather than leaving the cost meter to infer it.
 *
 * The caller supplies the collection, which is a deliberate difference from Classify Text next
 * door. A classifier's labels belong to the trained model, so accepting them from a caller would
 * misrepresent what a classifier is; a search engine's corpus belongs to whoever is searching. What
 * a caller still cannot supply is the scoring rule — the domain refuses a body carrying a metric, a
 * weighting, or a keyword list.
 *
 * Nothing is stored but vectors. The passages are already in the browser, results refer to them by
 * index rather than echoing them, and the embedding cache is keyed by a hash of the text rather
 * than by the text itself.
 */
export const semanticSearchRouter = new Hono<AppBindings>();

semanticSearchRouter.use(jsonBodyLimit(SEMANTIC_SEARCH_BODY_LIMIT_BYTES));

/**
 * Summarises what a validated request asked for, without disclosing its content.
 *
 * The query and the passages are recorded as counts alone. The strategy is logged because it is
 * frequently the whole explanation for a run's cost: one call for a reranker, up to two for an
 * embedding model, and none at all for a fully cached search.
 *
 * @param request The validated request.
 * @returns Structured fields describing the request's shape.
 */
function describeRequest(request: ValidatedSemanticSearchRequest): Record<string, unknown> {
  const controls = request.model.semanticSearchControls;

  return {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    // Which operation is about to happen. A cost question later is far easier to answer when the
    // log says whether this was a cacheable embedding run or a per-query cross-encoder one.
    strategy: controls?.strategy ?? null,
    queryCharacterCount: [...request.query].length,
    passageCount: request.passages.length,
    topK: effectiveTopK(request),
    // The upper bound on paid calls, before the cache is consulted. Comparing it with the actual
    // count in the completion line is what makes a cache hit visible in the logs.
    maximumCalls: controls?.strategy === 'cross-encoder' ? 1 : 2
  };
}

/**
 * Searches one collection and returns the ranking with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. Nothing is sent until the whole
 * search has completed, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Semantic Search service.
 * @returns A JSON `200` carrying {@link SemanticSearchResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, tries to supply a scoring rule, names an unknown model, submits a query that is
 *   empty or too long, submits a collection that is empty, too large, or holds a non-string, blank,
 *   or over-long passage, or sets a result count outside the model's declared range; `502` when the
 *   provider fails or returns no usable ranking; `503` when the account has insufficient AI Gateway
 *   credit, which cannot arise for the reviewed Cloudflare-hosted models but would for a
 *   third-party model added later.
 */
semanticSearchRouter.post('/', async (context) => {
  const request = validateSemanticSearchRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider,
  // or times out, or is cancelled mid-flight would otherwise leave no record of having been
  // attempted — which is precisely the case where knowing what was asked for matters most.
  logger.info('semantic_search_run_started', describeRequest(request));

  try {
    const result = await context.var.SEMANTIC_SEARCH_SERVICE.search(request, actor);

    // Deliberately free of the query, the passages, and the user's email. The *shape* of the
    // answer is recorded, not the answer: how many passages ranked and what the search cost, but
    // never which passage won, because for a search that is a statement about the visitor's own
    // content.
    logger.info('semantic_search_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      strategy: result.result.strategy,
      shownResults: result.result.rankings.length,
      totalRanked: result.result.totalRanked,
      // The three figures that explain the cost of this run, and the only place the cache's
      // effect is observable in the logs.
      inferenceCallCount: result.result.usage.inferenceCallCount,
      embeddedPassageCount: result.result.usage.embeddedPassageCount,
      cachedPassageCount: result.result.usage.cachedPassageCount,
      queryEmbedded: result.result.usage.queryEmbedded,
      logCount: result.receipt.logIds.length
    });

    const response: SemanticSearchResponse = {
      result: result.result,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier, and the service has logged why an output was refused. This line records the
    // panel-level outcome and repeats the request's shape, so one search for the run identifier
    // returns the whole story.
    logger.warn('semantic_search_run_failed', describeRequest(request));
    throw cause;
  }
});
