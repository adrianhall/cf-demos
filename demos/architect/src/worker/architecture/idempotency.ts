/**
 * Derive a deterministic job id from a diagram, requester, and client-supplied idempotency key.
 *
 * `POST /api/diagrams/:id/proposals`' idempotency mechanism does not add a new D1 column: the
 * job id (already the primary key, the Workflow instance id, and the R2 key's `<jobId>`
 * segment) doubles as the idempotency slot. The same three inputs always hash to the same id, so
 * `ArchitectureJobRepository.ensureJob()`'s `INSERT OR IGNORE` naturally makes a retried request
 * a no-op that resolves to the original job — matching Spike 08's own measured
 * `INSERT OR IGNORE` duplicate-start semantics — without requiring a separate idempotency-key
 * lookup table or column.
 *
 * The result is formatted to look like a UUID (purely for consistency with every other id in
 * this codebase); it is not an RFC 4122 UUID and must never be treated as one.
 *
 * @param diagramId Diagram the proposal is for.
 * @param requesterEmail Verified Cloudflare Access email of the requester.
 * @param idempotencyKey Client-supplied idempotency key.
 * @returns A deterministic, UUID-shaped identifier.
 */
export async function deriveIdempotentJobId(
  diagramId: string,
  requesterEmail: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${diagramId}:${requesterEmail}:${idempotencyKey}`,
    ),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
