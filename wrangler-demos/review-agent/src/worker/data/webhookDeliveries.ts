import type { Provider } from "../providers/types";

/**
 * Build the `review_webhook_deliveries.id` primary key from a provider and its own
 * provider-scoped delivery identifier (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration":
 * "Store `(provider, deliveryId)`..."; `migrations/0001_create_review_tables.sql`'s own comment
 * on this table: "the composite `"<provider>:<deliveryId>"` key the Worker builds itself").
 */
function deliveryRowId(provider: Provider, deliveryId: string): string {
  return `${provider}:${deliveryId}`;
}

/**
 * Idempotency guard against a provider's webhook retry starting a second review for a delivery
 * already accepted (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration"). MUST be called
 * before creating a `review_runs` row (Implementation Plan Phase 3, item 12's "verify → parse →
 * dedupe → insert run" order), so a retried delivery is caught before it can even race to create
 * one.
 *
 * Uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` -- confirmed against D1's SQLite
 * dialect to correctly return zero rows on a conflict, never an error -- so this is a single
 * round trip regardless of outcome.
 *
 * @param database D1 capability used to prepare the guard's statement.
 * @param provider Which provider delivered this webhook.
 * @param deliveryId The provider-scoped delivery identifier from
 * `GitProviderClient.verifyWebhook()`'s returned `WebhookEvent.deliveryId`.
 * @returns `true` the first time this `(provider, deliveryId)` pair is seen (the caller should
 * proceed to create a run); `false` when this exact delivery was already claimed (the caller
 * should treat the request as a no-op duplicate, not an error).
 */
export async function claimWebhookDelivery(
  database: Pick<D1Database, "prepare">,
  provider: Provider,
  deliveryId: string,
): Promise<boolean> {
  const claimed = await database
    .prepare(
      `INSERT INTO review_webhook_deliveries (id) VALUES (?)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    )
    .bind(deliveryRowId(provider, deliveryId))
    .first();
  return claimed !== null;
}

/**
 * Record which run a claimed delivery started, once its `review_runs` row exists. Split from
 * {@link claimWebhookDelivery} because the run's `id` is not known until after the claim
 * succeeds and `createOrGetReviewRun()` (`./reviewRuns.ts`) has run.
 *
 * @param database D1 capability used to prepare the update statement.
 * @param provider Which provider delivered this webhook.
 * @param deliveryId The same delivery identifier passed to {@link claimWebhookDelivery}.
 * @param runId The `review_runs.id` this delivery started (or matched via the idempotent
 * insert-or-return-existing path).
 */
export async function linkWebhookDeliveryToRun(
  database: Pick<D1Database, "prepare">,
  provider: Provider,
  deliveryId: string,
  runId: string,
): Promise<void> {
  await database
    .prepare(`UPDATE review_webhook_deliveries SET run_id = ? WHERE id = ?`)
    .bind(runId, deliveryRowId(provider, deliveryId))
    .run();
}
