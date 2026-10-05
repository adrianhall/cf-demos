/**
 * @file The Classify Text panel's wire contract. It sits in `src/shared/` beside the other panels'
 *   contracts because both tiers need it, and like them it carries no model descriptors — the
 *   browser learns which models exist and what each accepts from `/api/catalogue`. This panel's
 *   lesson is the **fixed-label contract**: a classifier sorts text into categories it was trained
 *   on, and the caller cannot invent them. That is what makes it different from Evaluate Choices,
 *   where the questions _are_ the caller's. The contract enforces that by having no field in which
 *   a label could be supplied — see {@link ClassifyTextRequest} — and the domain refuses a body
 *   that adds one rather than ignoring it. Two things make this contract different from Classify
 *   Image, which also ranks scored labels, and both come from the reviewed model contracts rather
 *   than from a design preference. **The reviewed models disagree about whether a classification
 *   has scores at all.** DistilBERT returns `[{ label, score }]` — a scored ranking, exactly like
 *   an image classifier. Llama Guard returns a _verdict_: a boolean plus a list of violated
 *   category codes, with **no score for anything**. There is no number to put in a confidence bar,
 *   and inventing one would be the worst possible response to that. So the outcome is a
 *   discriminated union, and {@link TextClassificationControlSupport.outcomeKind} tells the browser
 *   which it is about to receive. A panel that assumed a score would render `NaN%` against a
 *   perfectly valid answer. **Because of that, the ranking controls are not universal.** `topK` and
 *   `minimumConfidence` are meaningful only where there are scores to rank and filter. For a
 *   verdict model they are rejected rather than ignored, because a visitor who sets a confidence
 *   floor on a model that reports no confidence has formed a belief that is simply wrong. Nothing
 *   is stored. The text is already in the browser and the result travels back in the response, so
 *   there is no second copy to keep — see `tests/worker/panel-architecture.test.ts`, which holds
 *   that boundary.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest text the panel will classify, in characters.
 *
 * Lower than the other text panels' ceilings on purpose, and the reason is a model property rather
 * than a transport one. DistilBERT is a BERT derivative with a 512-token context window, and a text
 * beyond it is **silently truncated by the model** — the classifier returns a confident-looking
 * score for a prefix of what was submitted, with nothing in the response to say so. A limit that
 * sits inside that window means the score describes the text the visitor actually sent.
 *
 * The server validates every request against it; a browser-side counter is a courtesy, never a
 * control.
 */
export const MAX_CLASSIFICATION_TEXT_CHARACTERS = 1_500;

/**
 * Most labels the panel will ever show for one text.
 *
 * A bound rather than a preference, as in Classify Image: it caps the work the ranking step does on
 * an untrusted provider response, and keeps the result column a readable length.
 */
export const MAX_TEXT_CLASSIFICATION_LABELS = 10;

/**
 * What kind of answer a reviewed classifier produces.
 *
 * The most consequential field in this contract, because it decides whether the result can be
 * rendered as a confidence bar at all.
 *
 * - `scored-labels` — the model scores every label in its set and returns a number for each, so the
 *   result is a ranking. DistilBERT works this way.
 * - `verdict` — the model returns a decision plus the categories that drove it, and **no scores**.
 *   Llama Guard works this way. There is no ranking to make and no bar to draw.
 */
export type ClassificationOutcomeKind = 'scored-labels' | 'verdict';

/**
 * How a reviewed classifier wants its text.
 *
 * - `text` — a single `{ text }` field, which is the conventional classifier shape.
 * - `messages` — a chat-style `messages[]` array. Llama Guard needs this because it is a fine-tuned
 *   chat model rather than a classification head, which is also why its declared task type is Text
 *   Generation.
 *
 * Declared per model rather than inferred, so the request builder reads the shape from the reviewed
 * descriptor instead of branching on a model identifier.
 */
export type ClassificationInputShape = 'text' | 'messages';

/**
 * Where a result control is applied.
 *
 * - `model` — the control is a field in the model's own request schema, so the provider filters.
 * - `playground` — the model's schema has no such field, so this application applies the control to
 *   the response it received.
 *
 * Published rather than hidden because it changes what the control _means_. Asking a model for its
 * top 3 is a different operation from asking for everything and keeping three, and only the second
 * can be truthfully described as "showing 3 of the 5 labels this model returned". Every reviewed
 * model here is `playground`: neither has a ranking field in its schema.
 */
export type TextResultControlApplication = 'model' | 'playground';

/**
 * A numeric control a classifier exposes, with the range the server will accept.
 *
 * Structurally identical to Classify Image's equivalent and deliberately **not** shared with it, in
 * keeping with the convention the other panels follow: one published contract should not change
 * because another panel's did.
 */
export interface NumericTextClassificationRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation.
   */
  step: number;
  /**
   * Value used when the caller omits the control.
   */
  default: number;
}

/**
 * One category a reviewed model can emit, with the name to show for it.
 *
 * Carried as a pair because a code is not always self-explaining: Llama Guard reports `S1` rather
 * than `Violent Crimes`, and a result listing bare codes would be unreadable. The names come from
 * the published taxonomy, never from model output — see
 * {@link TextClassificationControlSupport.labelSet}.
 */
export interface ReviewedLabel {
  /**
   * The category identifier exactly as the model emits it.
   */
  code: string;
  /**
   * Human-readable name from the model's published label set or taxonomy.
   */
  name: string;
  /**
   * What this category covers, where the name alone is ambiguous.
   *
   * Optional because a sentiment label needs no gloss, while a hazard category genuinely does.
   */
  description?: string;
}

/**
 * Which controls one reviewed text classifier supports, and the label set it can emit.
 *
 * Every field was read from the model's own schema and published documentation. A control absent
 * from this declaration is rejected by validation rather than ignored, which is the direction every
 * other panel in this demo takes.
 */
export interface TextClassificationControlSupport {
  /**
   * Whether this model scores labels or returns a verdict; see {@link ClassificationOutcomeKind}.
   */
  outcomeKind: ClassificationOutcomeKind;
  /**
   * The request shape this model's schema declares; see {@link ClassificationInputShape}.
   */
  inputShape: ClassificationInputShape;
  /**
   * What this model's label set is called, shown so a visitor knows what the labels _are_.
   *
   * "Sentiment (SST-2)" and "Llama Guard 3 hazard taxonomy" are very different things, and a result
   * is not interpretable without knowing which produced it. This is the single most important piece
   * of explanatory copy in the panel, because it is what stops the labels reading as general
   * purpose.
   */
  labelSetName: string;
  /**
   * Every label or category this model can emit, published before any run.
   *
   * **Declared rather than discovered**, and that is the whole point of the panel. A visitor can
   * see the complete, closed set of answers the model is capable of giving _before_ submitting
   * anything — which is precisely what a fixed-label classifier offers and a text generator does
   * not. It also lets the panel name a returned code: Llama Guard reports `S1`, and the name for it
   * comes from here rather than from model output.
   */
  labelSet: readonly ReviewedLabel[];
  /**
   * How many of the highest-scoring labels to show.
   *
   * Absent for a verdict model, because there is nothing to rank.
   */
  topK?: NumericTextClassificationRange;
  /**
   * Lowest score a label must reach to be shown, as a fraction between 0 and 1.
   *
   * A floor rather than a filter on correctness: raising it hides low-scoring labels, it does not
   * make the remaining ones more likely to be right. Absent for a verdict model, because there is
   * no score to compare against.
   */
  minimumConfidence?: NumericTextClassificationRange;
  /**
   * Who applies the controls above; see {@link TextResultControlApplication}.
   */
  appliedBy: TextResultControlApplication;
  /**
   * Whether this model's own context window can silently truncate the submitted text.
   *
   * Disclosed because the failure is invisible: a model that truncates returns a normal-looking
   * score for a prefix of the text, with nothing in the response indicating that the rest was
   * ignored. {@link MAX_CLASSIFICATION_TEXT_CHARACTERS} is set to stay inside the smallest reviewed
   * window, so this is a caveat about the model rather than a live hazard in the panel.
   */
  contextWindowTokens?: number;
}

/**
 * Every control name a Classify Text request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const TEXT_CLASSIFICATION_CONTROL_NAMES = ['topK', 'minimumConfidence'] as const;

/**
 * One optional Classify Text control; see {@link TEXT_CLASSIFICATION_CONTROL_NAMES}.
 */
export type TextClassificationControlName = (typeof TEXT_CLASSIFICATION_CONTROL_NAMES)[number];

/**
 * What the browser posts to classify text.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * There is also **no field for a label, a category, or a question**, and that absence is the
 * panel's defining property rather than an omission. The labels belong to the model; a caller who
 * could supply them would be using Evaluate Choices, which is a different task with a different
 * API. The domain refuses a body that adds such a field, so the distinction is enforced rather than
 * merely documented.
 */
export interface ClassifyTextRequest {
  /**
   * The text to classify.
   */
  text: string;
  /**
   * Reviewed model identifier, which must be registered against the `classify-text` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * How many labels to show, within the selected model's declared range.
   *
   * Rejected for a model that reports no scores, because there is no ranking to truncate.
   */
  topK?: number;
  /**
   * Lowest score a label must reach to be shown, within the model's declared range.
   *
   * Rejected for a model that reports no scores, because there would be nothing to compare it to.
   */
  minimumConfidence?: number;
}

/**
 * One label the classifier scored, as the panel presents it.
 */
export interface ScoredClassificationLabel {
  /**
   * Position in the ranking, starting at 1.
   *
   * Carried explicitly rather than left to the array index, so a table, a list, and a screen reader
   * all agree on the ordinal even if a renderer re-sorts its own copy.
   */
  rank: number;
  /**
   * The category name exactly as the model reported it.
   */
  label: string;
  /**
   * Human-readable name for that category from the model's reviewed label set.
   *
   * Taken from the descriptor rather than from the response, so a model emitting an unexpected code
   * cannot put arbitrary text on the page. Falls back to the raw code when the label is not one the
   * reviewed set declares, which is itself worth seeing.
   */
  name: string;
  /**
   * The model's score for that category, between 0 and 1.
   *
   * Reported at full precision rather than rounded for display, so the structured disclosure shows
   * the model's actual output and the bar is the only thing doing any rounding.
   */
  score: number;
}

/**
 * A safety model's decision about the text.
 *
 * Deliberately not expressed as a scored label with a score of 1. The model reports no confidence
 * for its verdict, and giving it one would be inventing the most misleading number in the panel.
 */
export interface ClassificationVerdict {
  /**
   * Whether the model judged the text to fall outside its hazard taxonomy.
   */
  safe: boolean;
  /**
   * The categories the model reported, named from the reviewed taxonomy.
   *
   * Empty for a safe verdict. Every entry was matched against the published taxonomy before being
   * included, so an unrecognised code is reported as unrecognised rather than rendered as though it
   * were a known category.
   */
  categories: readonly ReviewedLabel[];
  /**
   * Category codes the model emitted that are not in the reviewed taxonomy.
   *
   * Carried rather than dropped, because a code outside the published set means the model's
   * taxonomy has changed and that is worth surfacing. Presented as raw codes with no invented
   * names.
   */
  unrecognisedCategories: readonly string[];
}

/**
 * The outcome of one classification, in whichever shape the selected model produces.
 *
 * A discriminated union rather than one shape with optional fields, so a `switch` in the browser is
 * checked for exhaustiveness and adding a third outcome kind fails the build until every renderer
 * handles it.
 */
export type ClassificationOutcome =
  | {
      /**
       * Discriminant: this model scored its labels.
       */
      kind: 'scored-labels';
      /**
       * The labels that survived the controls, highest score first.
       *
       * May be empty when every label scored below the requested floor. That is a real outcome of a
       * successful run rather than a failure, and the panel renders it as such.
       */
      labels: readonly ScoredClassificationLabel[];
      /**
       * How many usable labels the model returned before this application ranked and filtered them.
       *
       * Reported so the panel can say "showing 1 of the 2 labels this model returned" instead of
       * implying the model was asked for one.
       */
      totalLabels: number;
    }
  | {
      /**
       * Discriminant: this model returned a verdict and no scores.
       */
      kind: 'verdict';
      /**
       * The decision and the categories behind it; see {@link ClassificationVerdict}.
       */
      verdict: ClassificationVerdict;
    };

/**
 * The settings one classification was produced with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on.
 */
export interface AppliedTextClassificationControls {
  /**
   * Model identifier that produced the result.
   */
  model: string;
  /**
   * What the model's label set is called, so the result stays interpretable.
   */
  labelSetName: string;
  /**
   * Number of labels the result was limited to, including a default the caller did not set.
   *
   * Absent for a verdict model, which has no such control.
   */
  topK?: number;
  /**
   * Score floor applied, including a default the caller did not set.
   *
   * Absent for a verdict model, which reports no scores.
   */
  minimumConfidence?: number;
  /**
   * How many characters were submitted.
   *
   * The text itself is deliberately not echoed: the browser already has it, and a server that
   * returned a visitor's content back to them would put it in one more place for no benefit.
   */
  characterCount: number;
}

/**
 * What the Classify Text endpoint returns on success.
 */
export interface ClassifyTextResponse {
  /**
   * The classification, in whichever shape the model produces; see {@link ClassificationOutcome}.
   */
  outcome: ClassificationOutcome;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in.
   */
  applied: AppliedTextClassificationControls;
}
