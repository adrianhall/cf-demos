/**
 * @file Reviewed model descriptors. These are a hand-checked selection from the Workers AI
 *   catalogue, not a runtime scrape. A scraped catalogue would let a model whose input contract
 *   nobody has read decide whether a sales answer is grounded, which is precisely the decision this
 *   product must be able to defend. Each entry was read against its catalogue page before being
 *   added, and its request shape is pinned by `contractVersion` so a stored answer can be
 *   interpreted against the contract that actually produced it.
 */

/**
 * What a reviewed model is used for in the answer workflow.
 *
 * The two roles are kept apart because they have genuinely different requirements. The decision
 * model must return a small, parseable verdict and is asked for JSON; the answer model must write
 * prose a salesperson can read aloud. Using one model for both would mean tuning one prompt for two
 * incompatible jobs.
 */
export type ModelRole = 'decision' | 'answer';

/**
 * One reviewed Workers AI model.
 */
export interface ModelDescriptor {
  /**
   * Workers AI model identifier, exactly as the catalogue spells it.
   */
  id: string;
  /**
   * Which step of the workflow this model serves.
   */
  role: ModelRole;
  /**
   * Reviewed contract version of the request shape. Bumped whenever the parameters this demo sends
   * change, so a stored `modelId` plus this version identifies what was actually asked.
   */
  contractVersion: number;
  /**
   * Upper bound on generated tokens.
   *
   * Set per model rather than globally: a verdict needs very few tokens and an answer needs enough
   * for a paragraph with caveats. Bounding the output is also a cost control — an unbounded
   * generation is an unbounded charge.
   */
  maxTokens: number;
  /**
   * Sampling temperature.
   *
   * Low for both roles, and lowest for the decision. A routing verdict that varies between
   * identical inputs would make the escalation boundary irreproducible, and an answer grounded in
   * fixed evidence has nothing to be creative about.
   */
  temperature: number;
}

/**
 * The model that decides whether retrieved evidence supports an answer.
 *
 * A small, fast instruct model is the right choice: the task is a bounded classification over
 * evidence that has already been filtered, not open-ended reasoning, and the latency is paid by a
 * person waiting at a chat box. It is explicitly _not_ an authorization mechanism — see
 * {@link import('./answer-decision').AnswerDecision}.
 */
export const DECISION_MODEL: ModelDescriptor = {
  id: '@cf/meta/llama-3.2-3b-instruct',
  role: 'decision',
  contractVersion: 1,
  maxTokens: 192,
  temperature: 0
};

/**
 * The model that writes the answer from approved evidence.
 *
 * A larger instruct model, because this output is read by a salesperson and may be repeated to a
 * customer. The quality difference between a 3B and a 70B model is most visible exactly here: in
 * whether an answer that must carry a caveat actually carries it.
 */
export const ANSWER_MODEL: ModelDescriptor = {
  id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  role: 'answer',
  contractVersion: 1,
  maxTokens: 700,
  temperature: 0.2
};

/**
 * Every reviewed model, so the gateway-isolation test and any future catalogue endpoint read one
 * list rather than two.
 */
export const REVIEWED_MODELS: readonly ModelDescriptor[] = [DECISION_MODEL, ANSWER_MODEL];
