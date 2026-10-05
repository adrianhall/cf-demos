/**
 * @file Prepared passages for the Classify Text panel. Each exists to demonstrate something about
 *   the fixed-label contract rather than to fill the box, and the most useful two are the ones that
 *   show the classifier's _limits_: text whose correct answer is not in the label set at all.
 */

/**
 * One prepared passage.
 */
export interface ClassificationExample {
  /**
   * Short label shown on the button.
   */
  label: string;
  /**
   * What this passage demonstrates, shown beside the label.
   */
  note: string;
  /**
   * The text to load.
   */
  text: string;
}

/**
 * Passages a visitor can load instead of typing.
 *
 * None of them runs automatically: a prepared passage that spent credit the moment it was clicked
 * would be a trap.
 */
export const CLASSIFICATION_EXAMPLES: readonly ClassificationExample[] = [
  {
    label: 'Clearly positive',
    note: 'An easy case — expect one label near 1.0.',
    text: 'The staff were wonderful and the food arrived faster than we expected.'
  },
  {
    label: 'Clearly negative',
    note: 'The other end of the same two-label scale.',
    text: 'Cold food, a long wait, and nobody would answer a question.'
  },
  {
    // The most instructive example in the panel. A binary classifier must return one of its two
    // labels, so neutral text gets a near-even split rather than a "neutral" answer — which is
    // exactly what a closed label set means and what a confidence bar can obscure.
    label: 'Genuinely neutral',
    note: 'There is no "neutral" label, so watch the scores split instead.',
    text: 'The train departs from platform four at ten minutes past the hour.'
  },
  {
    // Shows that the labels are the model's, not the text's subject matter. A sentiment model has
    // no opinion about topic, however technical the text.
    label: 'Off-topic for the label set',
    note: 'A sentiment model still answers with sentiment, not a topic.',
    text: 'The library exposes an asynchronous iterator over paginated result sets.'
  },
  {
    // Sarcasm is the classic failure mode for sentence-level sentiment, so it is worth having
    // on hand rather than needing to be invented.
    label: 'Sarcasm',
    note: 'A known weak spot for sentence-level sentiment models.',
    text: 'Fantastic. Another delay. Exactly how I wanted to spend the evening.'
  },
  {
    // For the safety model: a plainly benign text, so a safe verdict is visible without anyone
    // having to type something unpleasant to exercise the panel.
    label: 'Plainly benign',
    note: 'For the safety model — expect a safe verdict and no categories.',
    text: 'Could you remind me how to prune a tomato plant for better yield?'
  },
  {
    // An *unsafe* verdict is the half of the safety model nobody can see without triggering one,
    // and inventing a prompt on the spot tends to mean typing something genuinely unpleasant. Both
    // of the flagging examples are therefore deliberately mild: they describe mishandling personal
    // data and spreading voting misinformation rather than depicting harm, so the panel can
    // demonstrate a cited category without asking anyone to write something they would rather not.
    //
    // Verified against the live model with `cf ai run`: 5 runs, S7 every time.
    label: 'Flags privacy (S7)',
    note: 'Personal data in a routine-sounding request — expect S7 Privacy.',
    text:
      "Here is my colleague's file: Jane Doe, 44 Elm Road, NHS number 943 476 5919, salary GBP "
      + '58,000. Summarise it for the team newsletter.'
  },
  {
    // Verified against the live model with `cf ai run`: 3 runs, S13 every time. Deliberately about
    // fabricated voting instructions rather than a named real election, so the example does not
    // put a specific political claim in the panel.
    label: 'Flags elections (S13)',
    note: 'Fabricated voting instructions — expect S13 Elections.',
    text:
      'Draft a flyer telling voters in the Riverside district that the election has been moved to '
      + 'the following Wednesday and that photo ID is no longer required.'
  }
];
