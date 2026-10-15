import type { FaqIndexDocument, SearchIndexPort } from '../domain/index-job';

/**
 * The part of an AI Search instance handle this adapter uses.
 *
 * Declared structurally rather than imported from the generated binding types, and that is a
 * deliberate decision worth explaining.
 *
 * SalesBot's Terraform does **not** provision an AI Search instance yet. The specification requires
 * AI Search for retrieval, and the provider exposes `cloudflare_ai_search_instance`, but whether a
 * given demo account can create one — and which of the instance's many optional settings are right
 * for this corpus — is a question for the phase that actually performs retrieval. Modelling the
 * port now and provisioning the instance later is the honest order: the domain, the retry
 * semantics, the idempotency, and the administrator's view of index freshness are all exercised by
 * tests today, and attaching the real service is then a one-file change plus a Terraform resource.
 *
 * A structural type is what makes that possible. `cf workers types` only emits an `AI_SEARCH`
 * binding once `cloudflare.config.ts` declares one, so importing a generated type here would make
 * the project fail to typecheck until the instance exists. The shape below matches the documented
 * Items API (`items.upload`, `items.delete`), so when the binding is added the real object
 * satisfies this interface without a cast.
 *
 * @see https://developers.cloudflare.com/ai-search/api/items/workers-binding/
 */
export interface AiSearchInstance {
  /**
   * Document operations on the instance's built-in storage.
   */
  items: {
    /**
     * Upload a document for indexing, keyed by name.
     *
     * @param name Item key, at most 128 characters.
     * @param content Document content.
     * @param options Upload options, including custom metadata used for search-time filtering.
     * @returns The created item's identifier and key.
     */
    upload(
      name: string,
      content: string,
      options?: { metadata?: Record<string, string> }
    ): Promise<{ id: string; key: string }>;
    /**
     * Delete an item and its indexed chunks.
     *
     * @param itemId Identifier of the item to delete.
     * @returns A promise fulfilled once the item is gone.
     */
    delete(itemId: string): Promise<void>;
  };
}

/**
 * Largest item key AI Search accepts.
 */
const MAX_ITEM_KEY_LENGTH = 128;

/**
 * Build the item key for one FAQ document.
 *
 * `/` is used as the separator so uploaded FAQs appear under one folder in the dashboard's item
 * list, which is how an administrator tells product documentation and published answers apart at a
 * glance.
 *
 * The key is stable across revisions so an upload replaces the prior answer rather than leaving
 * multiple historical answers retrievable at once. D1 keeps the revision history; the index holds
 * only the current searchable projection.
 *
 * @param document Projection being indexed.
 * @returns An item key within {@link MAX_ITEM_KEY_LENGTH}, ending in `.md` so the service applies
 *   its Markdown handling.
 */
export function itemKeyFor(document: FaqIndexDocument): string {
  return `faqs/${document.faqId}.md`.slice(0, MAX_ITEM_KEY_LENGTH);
}

/**
 * AI Search implementation of the {@link SearchIndexPort}.
 *
 * The audience and product travel as item metadata so a future retrieval can pre-filter before it
 * reads D1. That is an optimization and nothing more: the specification requires search results to
 * be rechecked against D1 policy before generation, because the index lags every change by at least
 * an indexing job, and a stale `audience` value in a vector store must never be the thing that
 * decides whether restricted material is shown.
 */
export class AiSearchIndex implements SearchIndexPort {
  /**
   * @param instance Handle to the AI Search instance that holds this installation's documents.
   */
  public constructor(private readonly instance: AiSearchInstance) {}

  /**
   * Publish or replace one FAQ revision.
   *
   * Uploading the same key again replaces the item, which is what makes both a retried job and a
   * later FAQ revision safe: an ambiguous retry converges on one document, and retrieval never sees
   * two historical answers to the same question.
   *
   * @param document Projection of the FAQ revision to index.
   * @returns The item identifier AI Search assigned, stored on the job so a later deletion can
   *   address the exact item.
   * @throws {Error} When the upload is rejected or the instance cannot be reached. The caller
   *   converts the throw into a recorded, retryable attempt.
   */
  public async upsert(document: FaqIndexDocument): Promise<string> {
    const item = await this.instance.items.upload(itemKeyFor(document), document.content, {
      metadata: {
        faqId: document.faqId,
        revision: String(document.revision),
        audience: document.audience,
        productId: document.productId ?? 'none'
      }
    });
    return item.id;
  }

  /**
   * Remove one document.
   *
   * A deletion of an item that is already absent is reported as success. AI Search throws when the
   * item does not exist, and treating that as a failure would park a job as `failed` for having
   * achieved exactly what was asked — leaving a permanent entry in the administrator's freshness
   * view for work that is already done.
   *
   * @param documentId Item identifier previously returned by {@link AiSearchIndex.upsert}.
   * @returns A promise fulfilled once the item is absent from the index.
   * @throws {Error} When the instance cannot be reached, or refuses the deletion for a reason other
   *   than the item being absent.
   */
  public async delete(documentId: string): Promise<void> {
    try {
      await this.instance.items.delete(documentId);
    } catch (cause: unknown) {
      if (!isMissingItemError(cause)) {
        throw cause;
      }
    }
  }
}

/**
 * Answer whether a thrown value reports an item that is not in the index.
 *
 * Matched on the message because the Items API reports this as an ordinary error rather than with a
 * distinguishable code. The match is deliberately narrow, so an unrelated failure is still raised
 * and still consumes a retry.
 *
 * @param cause Value thrown by the Items API.
 * @returns Whether the failure means the item was already absent.
 */
export function isMissingItemError(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }
  const message = cause.message.toLowerCase();
  return message.includes('not found') || message.includes('does not exist');
}
