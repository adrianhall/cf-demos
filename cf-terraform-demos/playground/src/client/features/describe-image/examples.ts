/**
 * @file Prepared questions to ask about a picture. Unlike the Create Image examples these cannot
 *   supply the subject — the visitor brings their own picture — so each one is a _question_ chosen
 *   to show something about how vision models behave. The last two matter most. Asking a model to
 *   read text and asking it to count things are the two tasks where a vision model will answer
 *   fluently and wrongly, and a visitor who only ever asks "what is this?" will leave believing the
 *   output is more reliable than it is.
 */

/**
 * One prepared question.
 */
export interface VisionExample {
  /**
   * Stable identifier, used as a list key and a test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * Question text loaded into the editor.
   */
  instruction: string;
  /**
   * What this example is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
}

/**
 * Prepared questions, in button order.
 */
export const VISION_EXAMPLES: readonly VisionExample[] = [
  {
    id: 'describe',
    label: 'Describe it',
    instruction: 'Describe this image in a few sentences.',
    teaches:
      'The baseline. Try it on both models: LLaVA will also caption a picture with no question '
      + 'at all, while Llama 3.2 Vision requires one.'
  },
  {
    id: 'alt-text',
    label: 'Write alt text',
    instruction:
      'Write a single concise sentence of alt text for this image, suitable for a screen reader.',
    teaches:
      'A genuinely useful application. Note how much shorter the answer is when you lower the '
      + 'answer-length cap.'
  },
  {
    id: 'read-text',
    label: 'Read the text',
    instruction: 'Transcribe any text visible in this image, exactly as it appears.',
    teaches:
      'Vision models read text confidently and often inaccurately. Try a photo of a sign and '
      + 'check every character against the original.'
  },
  {
    id: 'count',
    label: 'Count things',
    instruction: 'How many people are in this image? Answer with a number and explain briefly.',
    teaches:
      'Counting is a known weakness. The answer is usually fluent, specific, and wrong — which is '
      + 'exactly why it is worth seeing before trusting one of these models.'
  }
];
