/**
 * @file Prepared motion prompts for the Animate Image panel. Unlike Create Video's examples these
 *   carry no picture, and they could not: the subject is whatever the visitor uploaded or brought
 *   over from Create Image. What an example supplies is the _instruction_, which is the part most
 *   visitors find hardest — the common first attempt is to describe the picture, which a model has
 *   already got, rather than to describe what should change, which is the only thing it needs. Each
 *   example pins the cheapest useful duration for the same reason Create Video's do: clicking one
 *   commits real money, and an example that quietly selected fifteen seconds at the highest
 *   resolution would cost a few dollars to satisfy a moment's curiosity. Loading an example never
 *   starts a run. No `resolution` is pinned, deliberately, and that is a difference from Create
 *   Video worth recording. The two reviewed models here share no resolution value at all — `720P`
 *   against `768P` — so any spelling pinned in an example would be wrong for one of them. The
 *   duration is safe to pin because 5 is inside Alibaba's 3–15 range, and the panel resets a
 *   duration the selected model does not accept rather than sending one it would reject.
 */

/**
 * One prepared motion prompt.
 */
export interface AnimateExample {
  /**
   * Stable identifier, used as the button's test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * The motion prompt to load.
   */
  motionPrompt: string;
  /**
   * What the example is meant to demonstrate, shown as the button's tooltip.
   */
  teaches: string;
  /**
   * Duration in seconds to select, where the example depends on one.
   */
  duration?: number;
}

/**
 * The prepared motion prompts offered by the panel.
 *
 * Ordered by how reliably they work, which is itself the lesson. Camera motion needs no subject
 * consistency and almost always looks good; ambient motion is the middle case; animating a subject
 * is the hard one, and it is included precisely so a visitor can see where these models struggle
 * rather than only where they shine.
 */
export const ANIMATE_EXAMPLES: readonly AnimateExample[] = [
  {
    id: 'camera-push',
    label: 'Camera push-in',
    motionPrompt:
      'A slow, steady camera push into the scene, with gentle parallax between foreground and background',
    teaches:
      'Camera motion is the most reliable instruction for these models, because moving the viewpoint does not require any subject to stay consistent between frames.',
    duration: 5
  },
  {
    id: 'ambient',
    label: 'Ambient motion',
    motionPrompt:
      'Subtle ambient movement: drifting light, slowly shifting shadows, and a faint breeze through the scene',
    teaches:
      'Asking for atmosphere rather than action keeps every object where it started, which is usually the most convincing way to bring a still photograph to life.',
    duration: 5
  },
  {
    id: 'subject-motion',
    label: 'Animate the subject',
    motionPrompt:
      'The main subject turns slightly towards the camera and blinks, keeping their features and clothing unchanged',
    teaches:
      'The hard case: watch whether the subject stays recognisably the same person or object across the clip. Naming what should stay unchanged helps, but does not guarantee it.',
    duration: 5
  }
];
