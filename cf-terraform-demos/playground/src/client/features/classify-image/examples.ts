/**
 * @file Prepared control settings for Classify Image. Unlike every earlier panel's examples these
 *   are not prompts — a classifier has nothing to be asked — so each one sets the two result
 *   controls to a combination that shows something about how a classifier behaves. The third one
 *   matters most. A visitor who only ever looks at the top label leaves believing the model made a
 *   decision; seeing the whole ranking, including the near-miss in second place and the implausible
 *   guess in fifth, is what makes the scores legible as what they are.
 */

/**
 * One prepared combination of result controls.
 */
export interface ClassificationExample {
  /**
   * Stable identifier, used as a list key and a test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * Number of labels to show.
   */
  topK: number;
  /**
   * Score floor to apply, as a fraction between 0 and 1.
   */
  minimumConfidence: number;
  /**
   * What this combination is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
}

/**
 * Prepared control settings, in button order.
 */
export const CLASSIFICATION_EXAMPLES: readonly ClassificationExample[] = [
  {
    id: 'top-label',
    label: 'Top label only',
    topK: 1,
    minimumConfidence: 0,
    teaches:
      'How the result looks when you keep only the winner. Note that the model did not choose '
      + 'it — the panel did, by discarding everything else.'
  },
  {
    id: 'balanced',
    label: 'Top five',
    topK: 5,
    minimumConfidence: 0,
    teaches:
      'The default. The gap between first and second place is the most informative number here: '
      + 'a close pair means the model is genuinely unsure.'
  },
  {
    id: 'full-ranking',
    label: 'Everything it scored',
    topK: 10,
    minimumConfidence: 0,
    teaches:
      'The long tail. ImageNet has a thousand categories, and seeing the implausible ones scored '
      + 'is what shows these numbers are a distribution rather than a verdict.'
  },
  {
    id: 'confident-only',
    label: 'Confident guesses only',
    topK: 10,
    minimumConfidence: 0.5,
    teaches:
      'A high floor. Try a picture of something ImageNet has no category for: the list empties, '
      + 'which is more honest than a confident wrong answer.'
  }
];
