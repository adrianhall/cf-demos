/**
 * @file Prepared prompts for the Generate Music panel. Two rules shape this list, and both come
 *   from the panel rather than from a style preference. **Every example pins the cheapest useful
 *   length.** Clicking a prepared prompt here commits real money against prepaid AI Gateway
 *   credits, and an example that quietly selected two minutes would cost eight times what it needs
 *   to on the per-second model. Loading an example never starts a run, for the same reason. **The
 *   prompts are specific, deliberately.** A vague prompt — "some nice music" — produces a
 *   forgettable, generic result, and a visitor who only ever tries one leaves believing that is
 *   what music models do. Each example here names a genre, an instrument, a tempo feel, and a mood,
 *   because that combination is what makes the difference audible. One example exists specifically
 *   to demonstrate the contrast by being deliberately underspecified.
 */

/**
 * One prepared prompt.
 */
export interface MusicExample {
  /**
   * Stable identifier, used as a list key and the button's test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * The style prompt to load.
   */
  prompt: string;
  /**
   * What this example is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
  /**
   * Track length in seconds to select, where the selected model has a length control.
   *
   * Short on every example. A model with no length control ignores this and decides for itself,
   * which is itself part of what the panel demonstrates.
   */
  lengthSeconds: number;
  /**
   * Whether to request an instrumental track.
   *
   * Explicit on every example rather than left to the default, because it changes what the lyrics
   * controls mean — and for the per-track model it changes whether lyrics are required at all.
   */
  instrumental: boolean;
  /**
   * Lyrics to load, for an example demonstrating a vocal track.
   *
   * Present on exactly one example. The lyrics are deliberately plain and short: the point is to
   * show that supplied words are sung and are displayed beside the result, not to write a song.
   */
  lyrics?: string;
}

/**
 * The prepared prompts offered by the panel, in button order.
 *
 * Chosen to cover the range of things a music model is and is not good at: a texture with no
 * melodic commitment, a genre with a strong recognisable form, a vocal track with supplied words,
 * and a deliberately vague prompt for comparison. The last is the most instructive of the four.
 */
export const MUSIC_EXAMPLES: readonly MusicExample[] = [
  {
    id: 'ambient',
    label: 'Ambient texture',
    prompt:
      'A warm cinematic ambient piece: soft sustained piano chords, distant bowed strings, gentle '
      + 'tape hiss, slow and hopeful, no percussion',
    teaches:
      'The safest thing to ask a music model for. With no melody or rhythm to keep consistent '
      + 'there is very little to get wrong, which is why ambient prompts reliably sound polished.',
    lengthSeconds: 15,
    instrumental: true
  },
  {
    id: 'genre-form',
    label: 'A genre with rules',
    prompt:
      'An upbeat 1960s surf rock instrumental at about 150 BPM: reverb-drenched electric guitar '
      + 'lead, driving snare, walking bass, bright and energetic',
    teaches:
      'The harder case. A strongly defined genre has conventions a listener already knows, so a '
      + 'model that only half-commits to them is immediately audible.',
    lengthSeconds: 20,
    instrumental: true
  },
  {
    id: 'with-lyrics',
    label: 'Your own lyrics',
    prompt:
      'A warm acoustic folk ballad with fingerpicked guitar, light brushed drums, and a single '
      + 'gentle voice',
    teaches:
      'A vocal track with words you supplied, which only one of the models here accepts. The '
      + 'lyrics appear beside the player, so you can read what was sung.',
    lengthSeconds: 20,
    instrumental: false,
    lyrics:
      'Walking down a quiet road\nWith the evening turning gold\n'
      + 'Every step a story told\nOf the places I call home'
  },
  {
    id: 'vague',
    label: 'A vague prompt',
    prompt: 'Nice background music',
    teaches:
      'Here on purpose, as the comparison. Run it against one of the specific prompts above and '
      + 'the difference a detailed description makes stops being a claim and becomes something you '
      + 'can hear.',
    lengthSeconds: 10,
    instrumental: true
  }
];
