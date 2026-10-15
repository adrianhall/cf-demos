import type { Evidence } from './conversation';

/**
 * Why the workflow chose to escalate rather than answer.
 *
 * Reason codes rather than prose: they are stored on the escalation, shown in the PM queue, and
 * counted in the Phase 5 dashboards, all of which need a value that groups.
 */
export type EscalationReason = 'requested' | 'insufficient_evidence' | 'restricted_evidence';

/**
 * What the workflow decided to do with a question.
 *
 * A discriminated union rather than a boolean with optional fields, so the two outcomes cannot be
 * confused: an escalation always has a reason and an answer always has evidence, and there is no
 * representable state with neither or both.
 */
export type AnswerDecision =
  | {
      /**
       * Discriminator: the question will be answered from evidence.
       */
      outcome: 'answer';
      /**
       * The evidence the answer must be grounded in, already filtered against D1 policy.
       */
      evidence: Evidence[];
    }
  | {
      /**
       * Discriminator: the question goes to a person.
       */
      outcome: 'escalate';
      /**
       * Why, as a code an operator and a dashboard can both read.
       */
      reason: EscalationReason;
    };

/**
 * Fewest pieces of evidence the workflow will answer from.
 *
 * One is enough when it is a published FAQ written by the product's own PM — that is the whole
 * point of the knowledge base — so this is deliberately not "at least two". The protection against
 * a single weak match is {@link MIN_EVIDENCE_SCORE}, not a count.
 */
export const MIN_EVIDENCE_COUNT = 1;

/**
 * Lowest retrieval score the workflow will treat as evidence at all.
 *
 * AI Search's own default match threshold is 0.4, and anything scoring at that floor is a document
 * that mentioned the words rather than one that answers the question. Escalating is the safe
 * failure here: a salesperson who is told "a person will answer this" loses an hour, while one who
 * is given a confident answer assembled from a weak match may repeat it to a customer.
 */
export const MIN_EVIDENCE_SCORE = 0.5;

/**
 * How many pieces of evidence may enter the answer prompt.
 *
 * Bounded so a prompt cannot grow with the corpus. Five well-scored sources is more than enough to
 * answer a product question, and the bound is what keeps the token cost of a question predictable
 * no matter how much documentation is indexed.
 */
export const MAX_PROMPT_EVIDENCE = 5;

/**
 * Longest evidence passage included in a prompt, in characters.
 *
 * Applied per passage rather than to the assembled prompt, so one long documentation chunk cannot
 * crowd out four short FAQs. Truncation is visible to the model as a cut-off passage, which is
 * better than silently dropping the source entirely.
 */
export const MAX_EVIDENCE_CHARACTERS = 2_000;

/**
 * Select the evidence that may enter a prompt.
 *
 * Highest-scoring first, capped at {@link MAX_PROMPT_EVIDENCE}, with each passage bounded. The
 * ordering matters beyond relevance: a model given its best evidence first is less likely to ground
 * an answer in the weakest item it was shown.
 *
 * @param evidence Filtered evidence from retrieval.
 * @returns At most {@link MAX_PROMPT_EVIDENCE} items, best first, each passage truncated to
 *   {@link MAX_EVIDENCE_CHARACTERS}.
 */
export function boundEvidenceForPrompt(evidence: Evidence[]): Evidence[] {
  return [...evidence]
    .sort((first, second) => second.score - first.score)
    .slice(0, MAX_PROMPT_EVIDENCE)
    .map((item) => ({ ...item, content: item.content.slice(0, MAX_EVIDENCE_CHARACTERS) }));
}

/**
 * Decide whether retrieved evidence can support an answer at all.
 *
 * This runs **before** the decision model and is the authoritative half of the decision. It is a
 * deterministic rule over scores and counts, which means the escalation boundary is reproducible in
 * a test and cannot change because a model was retrained. The model's job is the narrower question
 * of whether the evidence actually addresses what was asked; it may only ever escalate something
 * this function would have answered, never the reverse.
 *
 * Stating that explicitly matters because the specification forbids using the decision model as a
 * substitute for authorization or expiry filtering. Both of those have already happened by the time
 * either this function or the model sees anything: retrieval filters against D1, and the answer
 * service filters again immediately before delivery.
 *
 * @param evidence Evidence surviving the audience, status, and expiry filter.
 * @param restrictedMatches How many retrieved sources were discarded because the requester is not
 *   cleared for them. A question whose only answers are restricted escalates with a distinguishable
 *   reason, so a PM can see that the person needs an answer they are not cleared to read.
 * @returns The decision: an answer with bounded evidence, or an escalation with its reason.
 */
export function assessEvidence(evidence: Evidence[], restrictedMatches: number): AnswerDecision {
  const usable = evidence.filter((item) => item.score >= MIN_EVIDENCE_SCORE);
  if (usable.length >= MIN_EVIDENCE_COUNT) {
    return { outcome: 'answer', evidence: boundEvidenceForPrompt(usable) };
  }
  return {
    outcome: 'escalate',
    reason: restrictedMatches > 0 ? 'restricted_evidence' : 'insufficient_evidence'
  };
}

/**
 * A verdict parsed from the decision model's JSON output.
 */
export interface DecisionVerdict {
  /**
   * Whether the model judged the evidence sufficient to answer the question asked.
   */
  grounded: boolean;
  /**
   * Short, content-free reason code the model supplied, or `null`. Recorded in logs only; never
   * shown to a requester, because it is model output rather than a reviewed message.
   */
  reasonCode: string | null;
}

/**
 * Parse the decision model's output into a verdict.
 *
 * The model is asked for `{"grounded": boolean, "reason": string}` and is nonetheless assumed to be
 * capable of returning anything at all. An unparseable verdict is treated as **not grounded**,
 * which escalates: when the component that judges whether an answer is safe cannot be understood,
 * the only defensible reading is that the answer is not safe.
 *
 * @param raw The model's generated text.
 * @returns The parsed verdict, or a non-grounded verdict when the output cannot be read.
 */
export function parseDecisionVerdict(raw: string): DecisionVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return { grounded: false, reasonCode: 'unparseable_verdict' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { grounded: false, reasonCode: 'unparseable_verdict' };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.grounded !== 'boolean') {
    return { grounded: false, reasonCode: 'unparseable_verdict' };
  }
  return {
    grounded: record.grounded,
    reasonCode: typeof record.reason === 'string' ? record.reason.slice(0, 60) : null
  };
}

/**
 * Extract the first JSON object from a model's output.
 *
 * Instruct models commonly wrap JSON in prose or a fenced code block even when asked not to.
 * Slicing to the outermost braces recovers the verdict in those cases; when there are no braces the
 * original text is returned so the caller's `JSON.parse` fails and the fail-closed path above
 * applies.
 *
 * @param raw The model's generated text.
 * @returns The substring most likely to be the JSON object.
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
