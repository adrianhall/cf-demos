/**
 * @file The Classify Image panel's wire contract: the picture the browser sends, and the ranked
 *   labels the Worker returns. It sits at `src/` beside `tasks.ts`, `runs.ts`, and
 *   `describe-image.ts` because both tiers need it. This panel is the first that is not generative.
 *   A classifier does not write a sentence about a picture; it scores the picture against a fixed
 *   list of categories it was trained on, and returns a number for each. Two consequences shape
 *   everything here. The first is that the result is _structured_ — a ranked list rather than prose
 *   — so the contract names the fields rather than returning a string. The second is that the
 *   numbers are easy to misread: a score of 0.93 is the model's own output, not a 93% chance that
 *   the label is true, and the panel says so in several places because a confidence bar is
 *   extremely good at implying otherwise. The reviewed model accepts no ranking parameters at all.
 *   Top-k and a confidence floor are therefore applied by this application to the response, never
 *   forwarded as request fields, and {@link ClassificationControlSupport.appliedBy} records that
 *   distinction in the contract so the UI can state it rather than implying the model was asked to
 *   filter.
 */

import type { VerifiedImageFacts } from './describe-image.ts';
import type { RunReceipt } from './runs.ts';

/**
 * Most labels the panel will ever show for one picture.
 *
 * A bound rather than a preference: the response is rendered as a ranked list beside the picture,
 * and a classifier with a thousand-category label set could otherwise return a list longer than the
 * page. It also bounds the work the ranking step does on an untrusted provider response.
 */
export const MAX_CLASSIFICATION_LABELS = 10;

/**
 * Where a result control is applied.
 *
 * - `model` — the control is a field in the model's own request schema, so the provider does the
 *   filtering.
 * - `playground` — the model's schema has no such field, so this application applies the control to
 *   the response it received.
 *
 * The distinction is published rather than hidden because it changes what the control _means_.
 * Asking a model for its top 3 is a different operation from asking for everything and keeping
 * three, and only the second one can be truthfully described as "showing 3 of the 5 labels this
 * model returned".
 */
export type ResultControlApplication = 'model' | 'playground';

/**
 * A numeric control a classifier exposes, with the range the server will accept.
 *
 * Structurally similar to the other panels' range types and deliberately separate from them, for
 * the same reason: sharing one type would couple this panel's published contract to another's, so a
 * later change to an image-generation control would silently alter what this panel advertises.
 */
export interface NumericClassificationRange {
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
 * Which result controls one reviewed classifier exposes.
 *
 * Every field is optional, so a model supports nothing it has not explicitly declared. A control
 * absent here is rejected by validation rather than ignored, which is the same direction every
 * other panel in this demo takes.
 */
export interface ClassificationControlSupport {
  /**
   * How many of the highest-scoring labels to show.
   */
  topK?: NumericClassificationRange;
  /**
   * Lowest score a label must reach to be shown, as a fraction between 0 and 1.
   *
   * A floor rather than a filter on correctness. Raising it hides low-scoring guesses; it does not
   * make the remaining ones more likely to be right.
   */
  minimumConfidence?: NumericClassificationRange;
  /**
   * Who applies the controls above; see {@link ResultControlApplication}.
   */
  appliedBy: ResultControlApplication;
}

/**
 * Every result-control name a Classify Image request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const CLASSIFICATION_CONTROL_NAMES = ['topK', 'minimumConfidence'] as const;

/**
 * One optional Classify Image control; see {@link CLASSIFICATION_CONTROL_NAMES}.
 */
export type ClassificationControlName = (typeof CLASSIFICATION_CONTROL_NAMES)[number];

/**
 * What the browser posts to classify a picture.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body that carries one rather than
 * ignoring it. There is no instruction field either — a classifier has nothing to be asked.
 */
export interface ClassifyImageRequest {
  /**
   * The picture, base64-encoded.
   *
   * No media type travels with it: the server identifies the format from the bytes, exactly as
   * Describe Image does, because a declared type is a value the browser chose.
   */
  imageBase64: string;
  /**
   * Reviewed model identifier, which must be registered against the `classify-image` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * How many labels to show, within the selected model's declared range.
   */
  topK?: number;
  /**
   * Lowest score a label must reach to be shown, within the model's declared range.
   */
  minimumConfidence?: number;
}

/**
 * One label the classifier scored, as the panel presents it.
 */
export interface ClassificationLabel {
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
   * The model's score for that category, between 0 and 1.
   *
   * Reported at full precision rather than rounded for display, so the expandable structured view
   * shows the model's actual output and the bar is the only thing doing any rounding.
   */
  score: number;
}

/**
 * The settings one classification was produced with.
 */
export interface AppliedClassificationControls {
  /**
   * Model identifier that produced the scores.
   */
  model: string;
  /**
   * Number of labels the result was limited to, including a default the caller did not set.
   */
  topK?: number;
  /**
   * Score floor applied, including a default the caller did not set.
   */
  minimumConfidence?: number;
}

/**
 * What the Classify Image endpoint returns on success.
 */
export interface ClassifyImageResponse {
  /**
   * The labels that survived the controls, highest score first.
   *
   * May be empty when every label scored below the requested floor. That is a real outcome of a
   * successful run rather than a failure, and the panel renders it as such.
   */
  labels: ClassificationLabel[];
  /**
   * How many labels the model returned before this application ranked and filtered them.
   *
   * Reported so the panel can say "showing 3 of the 5 labels this model returned" instead of
   * implying the model was asked for three. The model chooses how many categories it scores; a
   * top-k control can only narrow that list, never extend it.
   */
  totalLabels: number;
  /**
   * What the server verified about the submitted picture; see {@link VerifiedImageFacts}.
   */
  image: VerifiedImageFacts;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in.
   */
  applied: AppliedClassificationControls;
}
