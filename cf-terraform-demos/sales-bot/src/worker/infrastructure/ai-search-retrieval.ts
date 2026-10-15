import type { RetrievalCandidate, RetrievalPort, RetrievalQuery } from '../domain/retrieval';

/**
 * The part of an AI Search instance handle this adapter uses.
 *
 * Declared structurally for the same reason {@link import('./ai-search-index').AiSearchInstance}
 * is: `cf workers types` only emits an `AI_SEARCH` binding once `cloudflare.config.ts` declares
 * one, and SalesBot's Terraform still does not provision an instance — see `README.md` and
 * `./ai-search-index.ts` for why that remains deliberate. The shape matches the documented Search
 * API, so when the binding is added the real object satisfies this interface without a cast.
 *
 * @see https://developers.cloudflare.com/ai-search/api/search/workers-binding/
 */
export interface AiSearchQueryInstance {
  /**
   * Search the instance for relevant chunks.
   *
   * @param params Query string and retrieval options, including metadata filters.
   * @returns The matching chunks with their scores and source item references.
   */
  search(params: {
    query: string;
    ai_search_options?: {
      retrieval?: {
        max_num_results?: number;
        match_threshold?: number;
        filters?: Record<string, unknown>;
      };
    };
  }): Promise<{
    chunks: {
      score: number;
      text: string;
      item: { key: string; metadata?: Record<string, unknown> };
    }[];
  }>;
}

/**
 * Lowest score AI Search is asked to return.
 *
 * Set to the service's own documented default rather than to the workflow's stricter
 * {@link import('../domain/answer-decision').MIN_EVIDENCE_SCORE}. The domain applies the stricter
 * bound itself, and asking the index for slightly weaker matches than the workflow will use means a
 * log can report _that_ only weak matches existed — which is the difference between "nothing in the
 * corpus mentions this" and "the corpus mentions it but not well enough to answer from".
 */
const MATCH_THRESHOLD = 0.4;

/**
 * Prefix under which published FAQ projections are uploaded.
 *
 * Mirrors the item key {@link import('./ai-search-index').itemKeyFor} writes. The two constants are
 * deliberately in separate files because they serve opposite directions, and the round trip —
 * upload under `faqs/<id>.md`, read back an FAQ identifier from that key — is asserted in the unit
 * tests so a change to one without the other fails rather than silently stops matching.
 */
const FAQ_KEY_PREFIX = 'faqs/';

/**
 * Read an item's string metadata field.
 *
 * @param metadata Custom metadata recorded on the indexed item, when any.
 * @param field Field to read.
 * @returns The value, or `null` when absent or not a string.
 */
function metadataString(
  metadata: Record<string, unknown> | undefined,
  field: string
): string | null {
  const value = metadata?.[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Convert one search chunk into a retrieval candidate.
 *
 * The FAQ identifier is read from the item's `faqId` metadata when present and otherwise recovered
 * from the item key. Both paths exist because the metadata is what this application writes while
 * the key is what the service guarantees, and a candidate whose reference cannot be resolved is
 * useless: it could never be rechecked against D1, so it could never be cited.
 *
 * @param chunk One chunk from the search response.
 * @returns The candidate, or `null` when the chunk cannot be attributed to a known source.
 */
export function toCandidate(chunk: {
  score: number;
  text: string;
  item: { key: string; metadata?: Record<string, unknown> };
}): RetrievalCandidate | null {
  const key = chunk.item.key;
  const faqId =
    metadataString(chunk.item.metadata, 'faqId')
    ?? (key.startsWith(FAQ_KEY_PREFIX)
      ? key.slice(FAQ_KEY_PREFIX.length).replace(/\.md$/u, '')
      : null);

  if (faqId !== null) {
    return {
      sourceType: 'faq',
      reference: faqId,
      title: metadataString(chunk.item.metadata, 'title') ?? key,
      content: chunk.text,
      audience: metadataString(chunk.item.metadata, 'audience'),
      score: chunk.score
    };
  }

  if (key === '') {
    return null;
  }

  // Anything not under the FAQ prefix is an approved documentation page, keyed by its manifest
  // path. Documentation carries no audience of its own: the manifest only ever approves public
  // Cloudflare documentation, so it is classified `public` by the service that filters it rather
  // than guessed at here.
  return {
    sourceType: 'documentation',
    reference: key,
    title: metadataString(chunk.item.metadata, 'title') ?? key,
    content: chunk.text,
    audience: null,
    score: chunk.score
  };
}

/**
 * AI Search implementation of the {@link RetrievalPort}.
 *
 * The audience filter is sent to the service as a metadata filter so restricted material is not
 * transferred into the Worker at all. That is an optimization and a defence in depth, never the
 * access control: the index lags every FAQ change by at least an indexing job, so the authoritative
 * check is the one the answer service performs against D1 afterwards, and again immediately before
 * delivery.
 */
export class AiSearchRetrieval implements RetrievalPort {
  /**
   * @param instance Handle to the AI Search instance holding this installation's documents.
   */
  public constructor(private readonly instance: AiSearchQueryInstance) {}

  /**
   * Find candidate passages for a question.
   *
   * @param query Question, permitted audiences, and result bound.
   * @returns Candidate matches, best first, excluding any chunk that cannot be attributed to a
   *   source.
   * @throws {Error} When the instance cannot be reached or rejects the query.
   */
  public async search(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    const response = await this.instance.search({
      query: query.question,
      ai_search_options: {
        retrieval: {
          max_num_results: query.limit,
          match_threshold: MATCH_THRESHOLD,
          // Documentation items carry no `audience` metadata, so a bare `$in` would exclude them
          // all. The `$or` keeps them while still pre-filtering FAQ projections to the audiences
          // this requester is cleared for.
          filters: {
            $or: [{ audience: { $in: query.audiences } }, { audience: { $eq: null } }]
          }
        }
      }
    });

    return response.chunks
      .map(toCandidate)
      .filter((candidate): candidate is RetrievalCandidate => candidate !== null)
      .sort((first, second) => second.score - first.score);
  }
}
