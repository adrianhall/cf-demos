import type { FaqIndexDocument, SearchIndexPort } from '../domain/index-job';
import type { RetrievalCandidate, RetrievalPort, RetrievalQuery } from '../domain/retrieval';
import { AiSearchIndex, itemKeyFor, type AiSearchInstance } from './ai-search-index';
import { AiSearchRetrieval, type AiSearchQueryInstance } from './ai-search-retrieval';

/**
 * Worker bindings this factory inspects.
 *
 * `AI_SEARCH` is optional because SalesBot's Terraform does not provision an AI Search instance yet
 * — see {@link AiSearchInstance} for why that is deliberate rather than an oversight. Typing it as
 * optional here is what lets the whole indexing and retrieval pipeline be built, wired, and tested
 * before the instance exists, instead of the project failing to compile until it does.
 *
 * The type is the intersection of the write and read surfaces because one bound instance serves
 * both: documents are uploaded through `items` and queried through `search`.
 */
export interface SearchIndexEnv {
  /**
   * Bound AI Search instance, when the deployment has one.
   */
  AI_SEARCH?: AiSearchInstance & AiSearchQueryInstance;
}

/**
 * A search index that is not configured.
 *
 * Every operation fails with a clear, content-free message. That is the correct production
 * behaviour for a missing binding: jobs stay visible in the administrator freshness view as pending
 * and then failed, which is an accurate report that published answers are durable in D1 but not
 * searchable. Silently succeeding would be the dangerous alternative, because the freshness view
 * would then claim an index that holds nothing.
 */
export class UnconfiguredSearchIndex implements SearchIndexPort {
  /**
   * Reject an upload.
   *
   * @returns Never; it always throws.
   * @throws {Error} Always, explaining that no AI Search instance is bound.
   */
  public upsert(): Promise<string> {
    return Promise.reject(new Error('No AI Search instance is bound to this Worker.'));
  }

  /**
   * Reject a deletion.
   *
   * @returns Never; it always throws.
   * @throws {Error} Always, explaining that no AI Search instance is bound.
   */
  public delete(): Promise<void> {
    return Promise.reject(new Error('No AI Search instance is bound to this Worker.'));
  }
}

/**
 * An in-memory stand-in for AI Search, used only in local development.
 *
 * It exists so `pnpm start` demonstrates the complete publish-to-searchable journey — including the
 * administrator freshness view turning green — on a machine with no AI Search instance. It keeps
 * the same keys the real adapter would use, so what a developer sees locally corresponds to what
 * would be uploaded.
 *
 * It can never be selected in a deployed build: {@link createSearchIndex} gates it on
 * `import.meta.env.DEV`, which Vite replaces with the literal `false` in a production build, so the
 * class is removed from the bundle entirely.
 */
export class SimulatedSearchIndex implements SearchIndexPort, RetrievalPort {
  /**
   * Documents currently "indexed", keyed by the identifier handed back to the job.
   */
  private readonly documents = new Map<string, FaqIndexDocument>();

  /**
   * Record a document and return a stable identifier.
   *
   * @param document Projection of the FAQ revision to index.
   * @returns The item key the real adapter would have used, so a retry replaces rather than
   *   duplicates.
   */
  public upsert(document: FaqIndexDocument): Promise<string> {
    const key = itemKeyFor(document);
    this.documents.set(key, document);
    return Promise.resolve(key);
  }

  /**
   * Forget a document.
   *
   * Deleting something absent succeeds, matching the real adapter's contract.
   *
   * @param documentId Identifier previously returned by {@link SimulatedSearchIndex.upsert}.
   * @returns A promise fulfilled once the document is absent.
   */
  public delete(documentId: string): Promise<void> {
    this.documents.delete(documentId);
    return Promise.resolve();
  }

  /**
   * Read the simulated index, for local inspection and tests.
   *
   * @returns The currently indexed documents.
   */
  public contents(): FaqIndexDocument[] {
    return [...this.documents.values()];
  }

  /**
   * Find candidate passages by word overlap.
   *
   * Deliberately a crude lexical score rather than an attempt at semantic search: pretending to
   * approximate AI Search's ranking would be misleading, whereas an obvious word-overlap match is
   * clearly a stand-in. It is enough for `pnpm start` to demonstrate the complete publish-then-ask
   * journey — a locally published FAQ is retrievable, cited, and delivered — on a machine with no
   * AI Search instance.
   *
   * The audience pre-filter is applied here too, so the local path exercises the same two-stage
   * filtering the deployed one does rather than relying solely on the D1 recheck.
   *
   * @param query Question, permitted audiences, and result bound.
   * @returns Candidates whose content shares at least one significant word with the question.
   */
  public search(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    const terms = significantTerms(query.question);
    const candidates = [...this.documents.values()]
      .filter((document) => query.audiences.includes(document.audience))
      .map((document) => ({ document, score: overlapScore(document.content, terms) }))
      .filter((scored) => scored.score > 0)
      .sort((first, second) => second.score - first.score)
      .slice(0, query.limit)
      .map(({ document, score }) => ({
        sourceType: 'faq' as const,
        reference: document.faqId,
        title: document.content.split('\n')[0] ?? document.faqId,
        content: document.content,
        audience: document.audience,
        score
      }));
    return Promise.resolve(candidates);
  }
}

/**
 * Words long enough to be worth matching on.
 *
 * A stop-word list would be the thorough approach; a length filter is the honest one for a
 * simulation, because it is obviously approximate rather than appearing to be a real analyzer.
 *
 * @param text Question text.
 * @returns Lowercased words of four characters or more.
 */
function significantTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 4);
}

/**
 * Score a document by the fraction of question terms it contains.
 *
 * Normalized to 0–1 so the result is comparable with a real match score and the domain's
 * {@link import('../domain/answer-decision').MIN_EVIDENCE_SCORE} threshold means the same thing
 * locally as it does in production.
 *
 * @param content Indexed document content.
 * @param terms Significant question terms.
 * @returns A score between 0 and 1.
 */
function overlapScore(content: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = content.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

/**
 * A retrieval surface that is not configured.
 *
 * Fails with a clear, content-free message. That is the correct production behaviour for a missing
 * binding: the answer service converts a retrieval failure into an escalation, so a question
 * reaches a person rather than being answered from nothing. Returning an empty result instead would
 * be the dangerous alternative, because "no evidence exists" and "retrieval is broken" would become
 * indistinguishable.
 */
export class UnconfiguredRetrieval implements RetrievalPort {
  /**
   * Reject a search.
   *
   * @returns Never; it always rejects.
   * @throws {Error} Always, explaining that no AI Search instance is bound.
   */
  public search(): Promise<RetrievalCandidate[]> {
    return Promise.reject(new Error('No AI Search instance is bound to this Worker.'));
  }
}

/**
 * The one simulated index shared by every request in a development isolate.
 *
 * Module scope rather than per request on purpose: a new instance per request would forget each
 * document as soon as it was written, so the freshness view would never show anything indexed and
 * the local demonstration would be misleading. An isolate's lifetime is the right scope for a
 * simulation of a service that is itself external to the Worker.
 */
const simulatedIndex = new SimulatedSearchIndex();

/**
 * Choose the search-index adapter for a request.
 *
 * @param env Worker bindings for the current request.
 * @param isDevelopment Whether this is a development build. Pass `import.meta.env.DEV` so the
 *   simulation is statically unreachable in a deployed Worker.
 * @returns The AI Search adapter when an instance is bound; otherwise the local simulation in
 *   development, or an adapter that fails loudly in production.
 */
export function createSearchIndex(env: SearchIndexEnv, isDevelopment: boolean): SearchIndexPort {
  if (env.AI_SEARCH !== undefined) {
    return new AiSearchIndex(env.AI_SEARCH);
  }
  return isDevelopment ? simulatedIndex : new UnconfiguredSearchIndex();
}

/**
 * Choose the retrieval adapter for a request.
 *
 * Reads the same binding and the same module-scoped simulation as {@link createSearchIndex}, which
 * is what makes the local journey coherent: a FAQ published and indexed locally is findable
 * locally, because both halves address one simulated index rather than two.
 *
 * @param env Worker bindings for the current request.
 * @param isDevelopment Whether this is a development build. Pass `import.meta.env.DEV` so the
 *   simulation is statically unreachable in a deployed Worker.
 * @returns The AI Search adapter when an instance is bound; otherwise the local simulation in
 *   development, or an adapter that fails loudly in production.
 */
export function createRetrieval(env: SearchIndexEnv, isDevelopment: boolean): RetrievalPort {
  if (env.AI_SEARCH !== undefined) {
    return new AiSearchRetrieval(env.AI_SEARCH);
  }
  return isDevelopment ? simulatedIndex : new UnconfiguredRetrieval();
}
