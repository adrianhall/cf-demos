import type { Actor } from '../domain/actor';
import { isAudienceVisible, visibleAudiences, type Audience } from '../domain/audience';
import type { Evidence } from '../domain/conversation';
import { isFaqRetrievable, type FaqRepository } from '../domain/faq';
import type { RetrievalCandidate, RetrievalPort } from '../domain/retrieval';

/**
 * Result of one retrieval, after every policy check.
 */
export interface RetrievalResult {
  /**
   * Evidence the requester is cleared to be answered from.
   */
  evidence: Evidence[];
  /**
   * How many candidates were discarded because the requester is not cleared for them.
   *
   * Counted rather than merely dropped because the count changes the escalation reason: a question
   * whose only answers are restricted needs a person precisely _because_ the requester may not read
   * the source, and a PM looking at the queue needs to know that. The count carries no content, so
   * recording it is not a leak.
   */
  restrictedMatches: number;
  /**
   * How many candidates were discarded because the FAQ is archived, expired, or no longer in D1.
   *
   * Reported separately from restricted matches so an operator can distinguish a stale index from a
   * clearance problem — two very different things to fix.
   */
  staleMatches: number;
}

/**
 * How many candidates one retrieval asks the index for.
 *
 * Larger than {@link import('../domain/answer-decision').MAX_PROMPT_EVIDENCE} because candidates
 * are filtered after retrieval: asking for exactly as many as the prompt can hold would mean a
 * single expired FAQ in the results silently shrinks the evidence an answer is built from.
 */
export const RETRIEVAL_CANDIDATE_LIMIT = 15;

/**
 * Audience that approved Cloudflare documentation is treated as.
 *
 * The committed manifest only ever approves public developer documentation, so classifying it
 * `public` is a statement about the corpus rather than a convenience. Should a future manifest ever
 * approve non-public material, this constant is the single place the classification would have to
 * change — and the audience filter below would then apply to it automatically.
 */
const DOCUMENTATION_AUDIENCE: Audience = 'public';

/**
 * Retrieval with policy applied.
 *
 * This service exists so that **no caller can retrieve without the recheck**. The specification
 * requires search results to be verified against D1 before generation, because the index lags every
 * FAQ change by at least an indexing job — so a FAQ archived, expired, re-classified, or deleted
 * minutes ago can still be a search hit. The index is a way to find candidates quickly; D1 decides
 * what a person may be told.
 *
 * Three things are checked for every FAQ candidate, and all three are needed:
 *
 * 1. **The revision still exists in D1 and is retrievable.** `isFaqRetrievable` rejects an archived or
 *    expired entry regardless of its stored status, so expiry is enforced on read exactly as the
 *    specification requires, whether or not the scheduled marker has run.
 * 2. **The requester is cleared for its _current_ audience.** Read from D1, never from the index: a
 *    reclassified FAQ whose index metadata still says `public` must not be shown to somebody only
 *    cleared for public material.
 * 3. **The content comes from D1.** The answer is grounded in the stored revision rather than the
 *    indexed chunk, so an answer can never quote a passage that has since been edited away.
 */
export class RetrievalService {
  /**
   * @param retrieval Search-index read port.
   * @param faqs FAQ persistence port, consulted for every FAQ candidate.
   */
  public constructor(
    private readonly retrieval: RetrievalPort,
    private readonly faqs: FaqRepository
  ) {}

  /**
   * Retrieve evidence a requester may be answered from.
   *
   * @param actor Resolved authorization subject, supplying the clearance.
   * @param question The requester's validated question.
   * @param now Instant expiry is evaluated against, shared with the rest of the request.
   * @returns Permitted evidence and the counts of what was discarded and why.
   * @throws {Error} When the index cannot be reached or D1 rejects a read. The answer service
   *   converts an index failure into an escalation; a D1 failure is a genuine fault and
   *   propagates.
   */
  public async retrieve(actor: Actor, question: string, now: Date): Promise<RetrievalResult> {
    const candidates = await this.retrieval.search({
      question,
      audiences: visibleAudiences(actor.clearance),
      limit: RETRIEVAL_CANDIDATE_LIMIT
    });

    const evidence: Evidence[] = [];
    let restrictedMatches = 0;
    let staleMatches = 0;

    for (const candidate of candidates) {
      if (candidate.sourceType === 'documentation') {
        // Documentation is public by corpus definition, so the only check that applies is whether
        // this requester is cleared for public material — which everybody signed in is.
        if (isAudienceVisible(actor.clearance, DOCUMENTATION_AUDIENCE)) {
          evidence.push(toDocumentationEvidence(candidate));
        }
        continue;
      }

      const faq = await this.faqs.findLatest(candidate.reference);
      if (faq === null || !isFaqRetrievable(faq, now)) {
        staleMatches += 1;
        continue;
      }
      if (!isAudienceVisible(actor.clearance, faq.audience)) {
        restrictedMatches += 1;
        continue;
      }

      evidence.push({
        sourceType: 'faq',
        reference: faq.id,
        title: faq.question,
        // From D1, not from the index. This is what makes the recheck meaningful rather than
        // decorative: an answer quotes the stored revision, so it cannot repeat a passage that was
        // edited away after it was indexed.
        content: `${faq.question}\n\n${faq.answer}`,
        audience: faq.audience,
        score: candidate.score
      });
    }

    return { evidence, restrictedMatches, staleMatches };
  }

  /**
   * Re-apply the audience filter immediately before delivery.
   *
   * The specification requires this second pass, and it is not redundant with the first: generating
   * an answer takes seconds, and an administrator can lower a clearance or a PM can reclassify an
   * FAQ within them. Dropping a citation whose source is no longer permitted is the difference
   * between an answer that _was_ authorized and one that _is_.
   *
   * It returns the surviving evidence rather than a boolean so the caller can tell the difference
   * between "nothing changed" and "this answer is now grounded in less than it was written from".
   *
   * @param actor Resolved authorization subject.
   * @param evidence Evidence the answer was generated from.
   * @param now Instant expiry is evaluated against.
   * @returns The evidence still permitted at delivery time.
   * @throws {Error} When D1 rejects a read.
   */
  public async filterForDelivery(
    actor: Actor,
    evidence: Evidence[],
    now: Date
  ): Promise<Evidence[]> {
    const permitted: Evidence[] = [];
    for (const item of evidence) {
      if (item.sourceType === 'documentation') {
        permitted.push(item);
        continue;
      }
      const faq = await this.faqs.findLatest(item.reference);
      if (
        faq !== null
        && isFaqRetrievable(faq, now)
        && isAudienceVisible(actor.clearance, faq.audience)
      ) {
        permitted.push(item);
      }
    }
    return permitted;
  }
}

/**
 * Convert a documentation candidate into evidence.
 *
 * @param candidate Candidate whose source is an approved documentation page.
 * @returns The equivalent evidence, classified at {@link DOCUMENTATION_AUDIENCE}.
 */
function toDocumentationEvidence(candidate: RetrievalCandidate): Evidence {
  return {
    sourceType: 'documentation',
    reference: candidate.reference,
    title: candidate.title,
    content: candidate.content,
    audience: DOCUMENTATION_AUDIENCE,
    score: candidate.score
  };
}
