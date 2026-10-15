import type { CitationSourceType } from './conversation';

/**
 * One match returned by the search index, before any D1 policy check.
 *
 * Deliberately named a _candidate_: nothing here may be shown to anybody or given to a model until
 * it has been rechecked against D1. The index lags every FAQ change by at least an indexing job, so
 * its copy of the audience and status is a hint for pre-filtering and never the authority.
 */
export interface RetrievalCandidate {
  /**
   * Whether the match came from a published FAQ or an approved documentation page.
   */
  sourceType: CitationSourceType;
  /**
   * Stable reference: the FAQ identifier, or the documentation manifest path.
   */
  reference: string;
  /**
   * Item key or title as recorded in the index.
   */
  title: string;
  /**
   * The matched passage.
   */
  content: string;
  /**
   * Audience recorded on the indexed item, used only to pre-filter the query. Rechecked against D1.
   */
  audience: string | null;
  /**
   * Match score between 0 and 1.
   */
  score: number;
}

/**
 * What a retrieval asks for.
 */
export interface RetrievalQuery {
  /**
   * The requester's validated question.
   */
  question: string;
  /**
   * Audiences the requester is cleared to read, used to pre-filter the index query so restricted
   * material is not transferred into the Worker at all.
   */
  audiences: string[];
  /**
   * Largest number of candidates to return.
   */
  limit: number;
}

/**
 * Port for the retrieval side of the search index.
 *
 * Separate from {@link import('./index-job').SearchIndexPort}, which writes, because the two have
 * different consumers and different failure meanings: a failed write is a visible backlog an
 * administrator must act on, while a failed read is one question that escalates. Keeping them apart
 * means the answer workflow cannot accidentally depend on the indexing pipeline's retry semantics.
 */
export interface RetrievalPort {
  /**
   * Find candidate passages for a question.
   *
   * @param query Question, permitted audiences, and result bound.
   * @returns Candidate matches, best first. An empty array is a valid result and means the question
   *   escalates, not that something failed.
   * @throws {Error} When the index cannot be reached or rejects the query. The answer service
   *   converts that into an escalation rather than an error shown to the requester, because a
   *   retrieval outage should route questions to people instead of refusing them.
   */
  search(query: RetrievalQuery): Promise<RetrievalCandidate[]>;
}
