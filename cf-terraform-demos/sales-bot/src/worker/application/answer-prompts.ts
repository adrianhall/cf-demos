/**
 * @file The prompts the answer workflow sends. They live in their own module, separate from the
 *   service that sends them and the client that transports them, for one reason: a prompt is the
 *   product's instructions to a model about what it may claim, and changing one changes what the
 *   product will say to a salesperson who may repeat it to a customer. Keeping them in one small,
 *   reviewable file makes that change visible in a diff rather than buried inside a method.
 */

import type { Evidence } from '../domain/conversation';

/**
 * Instruction given to the decision model.
 *
 * It is asked only whether the evidence addresses the question — not whether the answer is
 * permitted, not whether the sources are current. Those are decided in code before this model is
 * called, and saying so in the prompt keeps the model from inventing a judgement it has no basis
 * for. The JSON shape is requested explicitly because the verdict is parsed; a model that ignores
 * the instruction yields an unparseable verdict, which fails closed to an escalation.
 */
export const DECISION_SYSTEM_PROMPT =
  'You judge whether the supplied evidence answers a Cloudflare sales question. '
  + 'Reply with JSON only, exactly: {"grounded": true|false, "reason": "<short_code>"}. '
  + 'Set grounded to true only when the evidence directly answers the question asked. '
  + 'Set it to false when the evidence is about a different product, answers a related but '
  + 'different question, or would require you to add facts the evidence does not contain. '
  + 'Do not consider permissions, freshness, or confidentiality; those are already checked.';

/**
 * Instruction given to the answer model.
 *
 * Every clause is doing work:
 *
 * - _Answer only from the evidence_ is the grounding rule the whole product rests on; a model that
 *   supplements from pre-training produces exactly the confidently-wrong answer a salesperson would
 *   repeat.
 * - _Refer to sources by number_ makes the stored citations verifiable against the text.
 * - _Say what the evidence does not cover_ is what makes a partial answer honest rather than a
 *   complete-looking one with a hole in it.
 * - _No pricing or commitments beyond the evidence_ exists because this is a sales tool: an invented
 *   figure or guarantee is the most expensive kind of mistake it could make.
 */
export const ANSWER_SYSTEM_PROMPT =
  'You answer Cloudflare sales questions for internal salespeople. '
  + 'Answer only from the supplied evidence. Never add product facts, figures, dates, pricing, '
  + 'roadmap claims, or commitments the evidence does not state. '
  + 'Refer to supporting evidence by its number, for example "(1)". '
  + 'If the evidence covers only part of the question, answer that part and say plainly which part '
  + 'it does not cover. Write two short paragraphs at most, in plain prose a salesperson can read '
  + 'aloud to a customer.';

/**
 * Build the decision model's user content.
 *
 * Only the title and a short excerpt of each passage are sent, not the full evidence. The decision
 * is about topical fit, which a title and an opening make clear; sending every passage twice — once
 * to decide and once to answer — would double the token cost of every question for no better
 * verdict.
 *
 * @param question The requester's validated question.
 * @param evidence Bounded evidence under consideration.
 * @returns The user-role content for the decision call.
 */
export function buildDecisionPrompt(question: string, evidence: Evidence[]): string {
  const summaries = evidence
    .map(
      (item, index) => `${index + 1}. [${item.sourceType}] ${item.title}\n${excerpt(item.content)}`
    )
    .join('\n\n');
  return `Question:\n${question}\n\nEvidence:\n${summaries}`;
}

/**
 * Build the answer model's user content.
 *
 * Evidence is numbered so the instruction to cite by number has something to refer to, and each
 * item names its source type so the model can say "the published FAQ" or "the documentation"
 * accurately. The passages arrive already bounded by
 * {@link import('../domain/answer-decision').boundEvidenceForPrompt}, so this function performs no
 * truncation of its own — one place deciding the prompt's size is one place to test.
 *
 * @param question The requester's validated question.
 * @param evidence Bounded evidence the answer must be grounded in.
 * @returns The user-role content for the answer call.
 */
export function buildAnswerPrompt(question: string, evidence: Evidence[]): string {
  const sources = evidence
    .map((item, index) => `(${index + 1}) [${item.sourceType}] ${item.title}\n${item.content}`)
    .join('\n\n');
  return `Question:\n${question}\n\nEvidence:\n${sources}`;
}

/**
 * Length of the excerpt sent to the decision model, in characters.
 *
 * Enough to establish what a passage is about, short enough that a deciding call over five passages
 * stays small.
 */
const DECISION_EXCERPT_LENGTH = 300;

/**
 * Take the opening of a passage for the decision prompt.
 *
 * @param content Evidence passage.
 * @returns At most {@link DECISION_EXCERPT_LENGTH} characters.
 */
function excerpt(content: string): string {
  return content.slice(0, DECISION_EXCERPT_LENGTH);
}
