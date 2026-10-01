/**
 * @file Prepared Create Image prompts. As with Chat, each exists to demonstrate something specific
 *   about the panel rather than to be impressive: an empty prompt box teaches nothing, and a
 *   visitor who does not know that diffusion models are weak at text or that step count drives cost
 *   will not discover it by typing "a cat".
 */

/**
 * One prepared prompt.
 */
export interface ImageExample {
  /**
   * Stable identifier, used as a list key and a test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * Prompt text loaded into the editor.
   */
  prompt: string;
  /**
   * What this example is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
}

/**
 * Prepared prompts, in button order.
 */
export const IMAGE_EXAMPLES: readonly ImageExample[] = [
  {
    id: 'detail',
    label: 'Fine detail',
    prompt:
      'A close-up of a dew-covered spider web at sunrise, backlit, shallow depth of field, '
      + 'photographic',
    teaches:
      'Detail rewards a higher step count. Generate it at the lowest and highest steps the model '
      + 'allows and compare both the result and the reported cost.'
  },
  {
    id: 'style',
    label: 'Strong style',
    prompt:
      'A lighthouse in a storm, in the style of a 1930s travel poster, flat colour, bold shapes',
    teaches:
      'A named style is followed far more reliably than a described one. Run the same prompt on '
      + 'both models to see how differently they interpret it.'
  },
  {
    id: 'negative',
    label: 'Needs a negative prompt',
    prompt: 'A quiet city street at night, wet tarmac, warm shop lights',
    teaches:
      'Add "people, cars, text" as a negative prompt on Stable Diffusion XL. FLUX.1 has no such '
      + 'control, which is why the field disappears when you select it.'
  },
  {
    id: 'text',
    label: 'Text in an image',
    prompt: 'A shop front with a hand-painted sign reading "OPEN LATE"',
    teaches:
      'Diffusion models are notoriously poor at rendering words. A reliable way to see a model '
      + 'fail at something it looks like it should manage.'
  }
];
