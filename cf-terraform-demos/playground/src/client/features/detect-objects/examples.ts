/**
 * @file Prepared target phrases for Detect Objects. The picture is the visitor's own, so unlike the
 *   other image panels there is nothing to prepare except the _question_ — and the question is
 *   where the interesting behaviour lives. Moondream takes a natural-language phrase rather than a
 *   label from a fixed set, which is the single biggest difference from Classify Image and the one
 *   least likely to be discovered by someone typing "dog" and stopping there. These exist to make
 *   that discoverable in one click.
 */

/**
 * A target phrase a visitor can try, with the point it demonstrates.
 */
export interface DetectionExample {
  /**
   * Short label for the control that applies it.
   */
  name: string;
  /**
   * The phrase sent to the model as its target.
   */
  target: string;
  /**
   * Why this phrase is worth trying, shown as the control's description.
   */
  teaches: string;
}

/**
 * Prepared targets, ordered from the plainest to the one that best shows the model's range.
 */
export const DETECTION_EXAMPLES: DetectionExample[] = [
  {
    name: 'A simple object',
    target: 'person',
    teaches:
      'The ordinary case, and the closest this panel gets to a fixed label. Every region returned is one person.'
  },
  {
    name: 'A described object',
    target: 'person wearing a red shirt',
    teaches:
      'The phrase is not a label from a list — the model narrows to the ones matching the description, which a classifier could not do.'
  },
  {
    name: 'Something absent',
    target: 'giraffe',
    teaches:
      'Against most pictures this finds nothing, which is a successful run with an empty result rather than a failure.'
  }
];
