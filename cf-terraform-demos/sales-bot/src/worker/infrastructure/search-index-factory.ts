import type { FaqIndexDocument, SearchIndexPort } from '../domain/index-job';
import { AiSearchIndex, itemKeyFor, type AiSearchInstance } from './ai-search-index';

/**
 * Worker bindings this factory inspects.
 *
 * `AI_SEARCH` is optional because SalesBot's Terraform does not provision an AI Search instance yet
 * — see {@link AiSearchInstance} for why that is deliberate rather than an oversight. Typing it as
 * optional here is what lets the whole indexing pipeline be built, wired, and tested before the
 * instance exists, instead of the project failing to compile until it does.
 */
export interface SearchIndexEnv {
  /**
   * Bound AI Search instance, when the deployment has one.
   */
  AI_SEARCH?: AiSearchInstance;
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
export class SimulatedSearchIndex implements SearchIndexPort {
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
