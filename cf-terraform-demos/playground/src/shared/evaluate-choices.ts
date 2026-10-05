/**
 * @file The Evaluate Choices panel's wire contract. It sits in `src/shared/` beside the other
 *   panels' contracts because both tiers need it, and like them it carries no model descriptors —
 *   the browser learns which models exist and what each accepts from `/api/catalogue`. This panel
 *   is the **inverse of Classify Text**, and the contrast is the entire reason both exist. A
 *   classifier owns its labels: the categories were fixed at training time and a caller who
 *   supplied one would be misrepresenting what a classifier is, so that contract has no field in
 *   which a label could be named. Here the questions, the types, the instructions, and the criteria
 *   are all the **caller's**, supplied per request — see {@link EvaluationQuestion}. The two panels
 *   cross-reference each other, and the boundary is enforced in both directions rather than
 *   described: Classify Text refuses a body carrying `questions`, and this panel refuses a body
 *   carrying a `prompt`. Three properties of the reviewed contract shape everything below, and each
 *   was verified against the live models with `cf ai run` rather than read from a schema and
 *   assumed. **The output is typed, not prose.** There is no JSON mode, no "respond only with valid
 *   JSON" incantation, and no parsing step anywhere in this panel. The model answers the questions
 *   it was asked, keyed by the names they were asked under, in a shape declared by each question's
 *   type. That is the lesson: a decision model is a typed API, not a text generator being coaxed
 *   into one. **Confidence is separate from the answer, and the two genuinely move independently.**
 *   Verified live: a clear-cut routing question answered `ENGINEERING` at probability `0.9831` with
 *   confidence `0.9334`, while the same question against the state `"Hello"` answered `ENGINEERING`
 *   at probability `0.7111` with confidence `0.1782`. The second answer _looks_ decisive and is the
 *   model telling you it is guessing. Prose output cannot express that distinction at all, which is
 *   why {@link ChoiceAnswer.confidence} is never folded into the probability and never rendered as
 *   the same bar — see {@link EvaluationAnswer}. **A `noul` answer has no confidence at all, while
 *   `choice` and `score` do.** This is a real asymmetry in the reviewed contract rather than an
 *   omission to paper over: a truth-valued judgement returns a bare probability and nothing else.
 *   The answer types are therefore a discriminated union rather than one shape with optional
 *   fields, so a renderer cannot read a confidence that was never sent — it would not compile. The
 *   state and the questions are **not** echoed in the response. They are already in the browser,
 *   and returning them would put a second copy of the visitor's content on the wire for no benefit;
 *   answers are keyed by question name, which the browser already holds.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest state the panel will evaluate, in characters.
 *
 * The state is the situation being judged — a support ticket, a review, a transcript, or a JSON
 * document carrying a ticket together with the policy it should be judged against. The ceiling sits
 * well inside the reviewed models' 65,536-token context window, so a state is never silently
 * truncated by the model. Silent truncation would be the worst failure this panel could have: the
 * answers would arrive looking entirely normal while describing only the part of the situation the
 * model actually read.
 *
 * The server validates every request against it; a browser-side counter is a courtesy, never a
 * control.
 */
export const MAX_EVALUATION_STATE_CHARACTERS = 12_000;

/**
 * Most questions one evaluation may ask.
 *
 * A **cost and latency** bound rather than a schema one. Asking several questions about one state
 * in a single call is the defining characteristic of a decision model — it is what makes this
 * cheaper than one classifier call per question — so the limit is set high enough that batching is
 * visibly the point. Ten questions in one call was verified live against the reviewed models.
 */
export const MAX_EVALUATION_QUESTIONS = 10;

/**
 * Most options one `choice` question may offer, or legend entries one `score` question may have.
 *
 * Twenty options in a single `choice` question was verified live and returned a probability for
 * every one of them. The limit exists because the panel renders a bar per option and a question
 * with fifty of them stops being readable long before the model stops answering.
 */
export const MAX_EVALUATION_OPTIONS = 20;

/**
 * Fewest options a `choice` or `score` question may have.
 *
 * **A provider constraint, not a preference.** Verified live: a single-option `choice` is rejected
 * with `Dictionary should have at least 2 items after validation, not 1`, and a single-entry
 * `score` legend with `List should have at least 2 items after validation, not 1`. The panel
 * enforces it locally so the visitor gets an actionable message naming the question, rather than a
 * provider validation error naming a field they never typed.
 */
export const MIN_EVALUATION_OPTIONS = 2;

/**
 * Longest question instruction, option description, or legend label, in characters.
 *
 * Instructions and criteria are prompts in the only sense this panel has one: they tell the model
 * what the question means and what each answer would look like. They are bounded so a single
 * question cannot consume the context window the state needs.
 */
export const MAX_EVALUATION_INSTRUCTION_CHARACTERS = 500;

/**
 * Pattern every question name must match.
 *
 * **Copied from the provider's own validation rather than invented.** Verified live: a name
 * containing a space is rejected with `String should match pattern '^[A-Za-z0-9_.-]{1,100}$'`.
 * Enforcing the identical rule locally means a visitor who types `my question` is told which
 * question is wrong and why, instead of receiving a provider error about a pattern they never saw.
 */
export const EVALUATION_QUESTION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;

/**
 * The kinds of question a caller may ask.
 *
 * - `noul` — a truth-valued judgement returning a **probability rather than a hard boolean**.
 *   Criteria describe what true and false look like. The name is the model's own.
 * - `choice` — selection from named options, each with a description, returning the chosen option
 *   plus a probability for _every_ option and a separate confidence.
 * - `score` — a graded rating over an ordered legend, returning a continuous score, a probability
 *   distribution across the legend positions, and a separate confidence.
 */
export const EVALUATION_QUESTION_TYPES = ['noul', 'choice', 'score'] as const;

/**
 * One question type; see {@link EVALUATION_QUESTION_TYPES}.
 */
export type EvaluationQuestionType = (typeof EVALUATION_QUESTION_TYPES)[number];

/**
 * A truth-valued question.
 *
 * Returns a probability, never a boolean. A question answered `0.52` and one answered `0.99` are
 * completely different findings, and rounding both to "yes" is exactly the information loss this
 * panel exists to avoid.
 */
export interface NoulQuestion {
  /**
   * Discriminant; see {@link EVALUATION_QUESTION_TYPES}.
   */
  type: 'noul';
  /**
   * What is being judged, phrased as a question.
   */
  instructions: string;
  /**
   * What a true answer looks like.
   *
   * Optional, because the reviewed models accept a `noul` question with no criteria at all —
   * verified live. Supplying them is strongly preferable and the panel's prepared scenarios all do,
   * because a criterion is how a caller says what _they_ mean by "urgent" rather than leaving the
   * model to assume.
   */
  whenTrue?: string;
  /**
   * What a false answer looks like.
   */
  whenFalse?: string;
}

/**
 * One named option of a `choice` question.
 */
export interface ChoiceOption {
  /**
   * The option's name, as it will appear in the answer.
   */
  name: string;
  /**
   * What this option covers, so the model can tell it from its neighbours.
   */
  description: string;
}

/**
 * A selection question over named options.
 */
export interface ChoiceQuestion {
  /**
   * Discriminant; see {@link EVALUATION_QUESTION_TYPES}.
   */
  type: 'choice';
  /**
   * What is being decided.
   */
  instructions: string;
  /**
   * The options to choose between, at least {@link MIN_EVALUATION_OPTIONS} of them.
   */
  options: ChoiceOption[];
}

/**
 * A graded rating over an ordered legend.
 */
export interface ScoreQuestion {
  /**
   * Discriminant; see {@link EVALUATION_QUESTION_TYPES}.
   */
  type: 'score';
  /**
   * What is being rated.
   */
  instructions: string;
  /**
   * The ordered legend, lowest first, with at least {@link MIN_EVALUATION_OPTIONS} entries.
   *
   * **Order is the meaning here**, which is what makes a `score` different from a `choice` over the
   * same labels. The returned score is a continuous position along this list, so reordering the
   * legend changes what every number means.
   */
  legend: string[];
}

/**
 * One typed question, discriminated by {@link EvaluationQuestionType}.
 *
 * A union rather than one shape with optional fields, so a `choice` cannot be built without its
 * options and a `score` cannot be built without its legend. The alternative — one interface where
 * everything is optional — moves those errors from compile time to a provider validation failure.
 */
export type EvaluationQuestionBody = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/**
 * One question together with the name its answer will be keyed under.
 *
 * Carried as a list rather than as an object keyed by name, even though the provider's own schema
 * is an object. Two reasons, both about the panel rather than the provider: a list has an order the
 * visitor controls and the question builder can reorder, and a list can briefly hold a duplicate
 * name while someone is typing, which an object silently cannot — the first question would vanish.
 * The domain converts to the provider's keyed object after rejecting duplicates.
 */
export interface EvaluationQuestion {
  /**
   * The answer key, matching {@link EVALUATION_QUESTION_NAME_PATTERN}.
   */
  name: string;
  /**
   * The question itself.
   */
  question: EvaluationQuestionBody;
}

/**
 * How the caller supplied the state.
 *
 * - `text` — free text: a support message, a review, a transcript.
 * - `json` — a structured document. The more interesting case, because question instructions can then
 *   reference fields by name. Verified live: given a state carrying `order.days_since: 40` and
 *   `policy.window_days: 30`, a refund-eligibility question answered `0.0306` — the model compared
 *   two fields rather than matching words.
 *
 * Published in the result because it changes how a visitor should read an answer, and recorded in
 * the applied controls rather than inferred from the state's first character.
 */
export type EvaluationStateFormat = 'text' | 'json';

/**
 * What one reviewed decision model accepts, and what it costs.
 *
 * Every field was read from the model's catalogue entry and verified against the live model. A
 * control absent from this declaration is rejected by validation rather than ignored, which is the
 * direction every other panel in this demo takes.
 */
export interface EvaluationControlSupport {
  /**
   * The short model name the provider requires in the request body.
   *
   * **Not cosmetic, and not derivable by trimming the identifier.** The reviewed contract carries a
   * `model` field _inside_ the body, and it must agree with the endpoint being called: sending
   * `"clef"` to the `clef-flash` endpoint fails with `Unsupported model 'clef'. Use 'clef-flash'.`
   * Recording the exact string in the reviewed descriptor keeps it beside the contract it came from
   * rather than leaving the service to derive it with string surgery.
   */
  requestModelName: string;
  /**
   * Every question type this model answers.
   */
  supportedQuestionTypes: readonly EvaluationQuestionType[];
  /**
   * Whether this model returns a confidence separate from the answer for `choice` and `score`.
   *
   * Declared rather than assumed because the panel's central claim depends on it. A model that
   * returned no confidence would need the UI to say so, not to leave an empty gauge implying zero.
   */
  reportsConfidence: boolean;
  /**
   * Context window in tokens.
   *
   * Surfaced in the UI beside a live token count of the state, which is the View Tokens handoff
   * this panel owes: a large structured state consumes the window quickly, and the only honest way
   * to say so is to show the number.
   */
  contextWindowTokens: number;
  /**
   * What the model charges for, per million input tokens, in USD.
   *
   * Carried for a reason specific to this panel: these models have an **asymmetric** price.
   * Verified live, every response reported `output_tokens: 0` — the typed answer is not generated
   * text, so there is no output to bill. Publishing the input price beside that fact is what makes
   * the contrast with a generative panel legible. It is a reviewed catalogue figure for explanation
   * only; the authoritative cost of any run is the one AI Gateway reports.
   */
  inputPricePerMillionTokens: number;
}

/**
 * What the browser posts to run one evaluation.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it. There is also no `prompt`, no `system`, no `messages`, and no `temperature` — see
 * `src/worker/domain/evaluate-choices.ts`. A decision model is not a chat model, and an API that
 * appeared to accept a prompt would teach that it is.
 */
export interface EvaluateChoicesRequest {
  /**
   * The situation to judge.
   *
   * Sent as a string in both formats. When `stateFormat` is `json` the domain parses it to confirm
   * it is valid and forwards the parsed document, so the model receives structured data rather than
   * a string that happens to contain braces.
   */
  state: string;
  /**
   * How to interpret {@link EvaluateChoicesRequest.state}.
   */
  stateFormat: EvaluationStateFormat;
  /**
   * The questions to ask, in the caller's own order.
   */
  questions: EvaluationQuestion[];
  /**
   * Reviewed model identifier, which must be registered against the `evaluate-choices` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
}

/**
 * The answer to a `noul` question.
 *
 * **Carries no confidence**, because the reviewed models return none for this type — verified
 * across many live calls. Modelling that absence in the type rather than as an optional field is
 * what stops a renderer displaying a confidence of zero for a question that simply has none.
 */
export interface NoulAnswer {
  /**
   * Discriminant.
   */
  type: 'noul';
  /**
   * Probability that the judgement is true, between 0 and 1.
   *
   * Never rounded to a boolean anywhere in this panel. `0.52` and `0.99` are different findings.
   */
  probability: number;
}

/**
 * One option's share of a `choice` answer, or one legend position's share of a `score` answer.
 */
export interface OptionProbability {
  /**
   * The option name, or the legend label for a `score`.
   */
  name: string;
  /**
   * Probability the model assigned, between 0 and 1.
   */
  probability: number;
  /**
   * Whether this is the option the model selected.
   *
   * Carried explicitly rather than recomputed by each renderer as "the highest one", so the table,
   * the bars, and the screen-reader text cannot disagree about which option won.
   */
  selected: boolean;
}

/**
 * The answer to a `choice` question.
 */
export interface ChoiceAnswer {
  /**
   * Discriminant.
   */
  type: 'choice';
  /**
   * The option the model selected.
   */
  choice: string;
  /**
   * A probability for every offered option, in the order the caller listed them.
   *
   * Caller order rather than probability order, so a visitor comparing two runs reads the same rows
   * in the same places. The winner is marked rather than moved.
   */
  probabilities: readonly OptionProbability[];
  /**
   * How confident the model is in that selection, between 0 and 1.
   *
   * **Independent of the probability, and that is the point.** Verified live, the same question
   * answered `ENGINEERING` at `0.9831`/confidence `0.9334` for a clear state and at
   * `0.7111`/confidence `0.1782` for an empty one. Rendered as its own control, never merged into
   * the probability bar.
   */
  confidence: number;
}

/**
 * The answer to a `score` question.
 */
export interface ScoreAnswer {
  /**
   * Discriminant.
   */
  type: 'score';
  /**
   * The continuous score, as a position along the legend starting at 0.
   *
   * Continuous rather than snapped to a legend entry: a `3.51` on a five-entry legend sits between
   * the fourth and fifth labels, and rounding it to one of them would discard the judgement the
   * model actually made.
   */
  score: number;
  /**
   * The legend the score is positioned along, lowest first.
   *
   * Echoed from the model's own response rather than from the request, so the rendered axis is the
   * one the score was actually computed against.
   */
  legend: readonly string[];
  /**
   * A probability for every legend position.
   */
  probabilities: readonly OptionProbability[];
  /**
   * How confident the model is, between 0 and 1; see {@link ChoiceAnswer.confidence}.
   */
  confidence: number;
}

/**
 * One typed answer, discriminated by its question type.
 *
 * A discriminated union rather than one shape with optional fields, for the same reason the
 * question types are: a `noul` has no confidence, and a renderer should not be able to ask for
 * one.
 */
export type EvaluationAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/**
 * One question's answer, keyed by the name it was asked under.
 */
export interface EvaluatedQuestion {
  /**
   * The question name, matching the one submitted.
   */
  name: string;
  /**
   * The typed answer.
   */
  answer: EvaluationAnswer;
}

/**
 * What one evaluation reported about its own cost.
 *
 * Separate from the receipt because this is the _model's_ own accounting, which here makes a point
 * the receipt cannot. Verified live on every call: `output_tokens` is always `0`, because a typed
 * decision is not generated text. A generative panel bills for both halves; this one bills for what
 * it read.
 */
export interface EvaluationUsage {
  /**
   * Input tokens the model reported consuming.
   */
  inputTokens: number;
  /**
   * Output tokens the model reported producing.
   *
   * Always `0` for the reviewed models. Reported rather than omitted, because a visible zero is
   * what makes the asymmetric pricing legible — omitting the field would just look like a gap.
   */
  outputTokens: number;
}

/**
 * The outcome of one evaluation.
 */
export interface EvaluationResult {
  /**
   * One answer per question asked, in the order the questions were submitted.
   */
  answers: readonly EvaluatedQuestion[];
  /**
   * Names of questions that were asked but came back with no usable answer.
   *
   * Normally empty. Reported rather than silently dropped: a visitor who asked five questions and
   * sees four cards is owed an explanation of where the fifth went, and a shorter list with no
   * comment is indistinguishable from never having asked.
   */
  unansweredQuestions: readonly string[];
  /**
   * What the model reported consuming; see {@link EvaluationUsage}.
   */
  usage: EvaluationUsage;
}

/**
 * The settings an evaluation was produced with, echoed so the UI can describe the run honestly.
 *
 * The state and the questions are **not** echoed. They are already in the browser, and returning
 * them would create a second copy of the visitor's content in the response for no benefit.
 */
export interface AppliedEvaluationControls {
  /**
   * Model the evaluation ran against.
   */
  model: string;
  /**
   * How the state was interpreted.
   */
  stateFormat: EvaluationStateFormat;
  /**
   * How many questions were asked.
   */
  questionCount: number;
  /**
   * How many questions of each type were asked.
   *
   * Recorded as counts rather than as the questions themselves, so the shape of the request is
   * describable in a log line that contains none of the visitor's wording.
   */
  questionTypeCounts: Record<EvaluationQuestionType, number>;
  /**
   * Length of the state in characters, recorded instead of the state itself.
   */
  stateCharacterCount: number;
}

/**
 * What `POST /api/evaluate-choices` returns.
 */
export interface EvaluateChoicesResponse {
  /**
   * The typed answers and the model's own usage report.
   */
  result: EvaluationResult;
  /**
   * The run receipt.
   */
  receipt: RunReceipt;
  /**
   * The settings the evaluation was produced with.
   */
  applied: AppliedEvaluationControls;
}
