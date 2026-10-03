/**
 * @file Prepared passages for the Translate Text panel. Each one exists to demonstrate something
 *   specific rather than to fill the box, and two of them are about the panel's own mechanics
 *   rather than about translation quality.
 */

/**
 * One prepared passage.
 */
export interface TranslationExample {
  /**
   * Short label shown on the button.
   */
  label: string;
  /**
   * What this passage demonstrates, shown beside the label.
   */
  note: string;
  /**
   * The text to load, with its line structure.
   */
  text: string;
}

/**
 * Passages a visitor can load instead of typing.
 *
 * None of them runs automatically: a prepared passage that spent credit the moment it was clicked
 * would be a trap, and this panel's per-line billing makes that sharper than elsewhere.
 */
export const TRANSLATION_EXAMPLES: readonly TranslationExample[] = [
  {
    label: 'A single sentence',
    note: 'One line, so one paid call on every model.',
    text: 'The water in the harbour is colder than it looks.'
  },
  {
    // The passage that makes this panel's cost lesson visible: the same text is one charge on a
    // batching model and five on the other.
    label: 'A multi-line list',
    note: 'Five lines. One paid call on a batching model, five on the others.',
    text: [
      'Check the tide times before setting out.',
      'Take more water than you think you need.',
      'Tell someone where you are going.',
      'Turn back if the weather changes.',
      'Leave nothing behind.'
    ].join('\n')
  },
  {
    // Demonstrates the formatting promise rather than the translation. The blank line in the middle
    // is the interesting part: it survives in position and costs nothing.
    label: 'Paragraphs with a blank line',
    note: 'The blank line is preserved and is never sent to a model.',
    text: [
      'The ferry leaves at six in the morning.',
      '',
      'There is a cafe on the pier that opens earlier, if you want breakfast first.'
    ].join('\n')
  },
  {
    label: 'An idiom',
    note: 'Shows where a sentence-level translator struggles.',
    text: 'It is raining cats and dogs, so we may as well call it a day.'
  }
];
