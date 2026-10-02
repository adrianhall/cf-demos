/**
 * @file Prepared prompts for the Create Video panel. Every example pins the cheapest useful
 *   settings rather than leaving them at a model's own default. That is a deliberate difference
 *   from the other panels' examples: clicking a prepared prompt here commits real money, and an
 *   example that quietly selected 1080p for fifteen seconds would cost several dollars to satisfy a
 *   moment's curiosity. Loading an example never starts a run, for the same reason.
 */

/**
 * One prepared prompt.
 */
export interface VideoExample {
  /**
   * Stable identifier, used as the button's test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * The prompt to load.
   */
  prompt: string;
  /**
   * What the example is meant to demonstrate, shown as the button's tooltip.
   */
  teaches: string;
  /**
   * Resolution to select, where the example depends on one. Spelled as PixVerse spells it, since it
   * is the default model; a model that spells it differently ignores the value and falls back to
   * its own default rather than sending a string its schema rejects.
   */
  resolution?: string;
  /**
   * Duration in seconds to select.
   */
  duration?: number;
}

/**
 * The prepared prompts offered by the panel.
 *
 * Chosen to show different things a text-to-video model is and is not good at: steady camera
 * motion, a subject with articulated movement, and a scene with no subject at all. The last is
 * included because it is the one that most reliably looks good, which is itself worth noticing.
 */
export const VIDEO_EXAMPLES: readonly VideoExample[] = [
  {
    id: 'camera-move',
    label: 'Camera move',
    prompt:
      'A slow aerial push over a misty pine forest at sunrise, soft volumetric light, cinematic',
    teaches:
      'Camera motion is what these models handle most convincingly, because it does not require a subject to stay consistent between frames.',
    resolution: '360p',
    duration: 5
  },
  {
    id: 'moving-subject',
    label: 'Moving subject',
    prompt: 'A golden retriever running through tall grass towards the camera, slow motion',
    teaches:
      'A subject with legs is the hard case: watch whether limbs and paws stay coherent across the clip.',
    resolution: '360p',
    duration: 5
  },
  {
    id: 'no-subject',
    label: 'Texture only',
    prompt:
      'Close-up of ink diffusing into water, swirling dark blue tendrils, macro, black background',
    teaches:
      'With no subject to keep consistent, there is nothing to get wrong — which is why abstract texture prompts tend to look the most polished.',
    resolution: '360p',
    duration: 5
  }
];
