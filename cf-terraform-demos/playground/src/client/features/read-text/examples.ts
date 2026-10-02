/**
 * @file Prepared passages for Read Text. Each one exists to make something about speech synthesis
 *   audible rather than to show that the panel works. The second matters most: Aura's own
 *   documentation states that the quality of the text input directly affects how natural the output
 *   sounds, because the model infers pacing and emphasis from punctuation. A visitor who only ever
 *   submits a bare sentence never hears that, and leaves believing a TTS model simply reads words.
 */

/**
 * One prepared passage.
 */
export interface SpeechExample {
  /**
   * Stable identifier, used as a list key and a test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * The passage to load into the editor.
   */
  text: string;
  /**
   * What this passage is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
}

/**
 * Prepared passages, in button order.
 */
export const SPEECH_EXAMPLES: readonly SpeechExample[] = [
  {
    id: 'greeting',
    label: 'A short greeting',
    text: 'Hello, and welcome to the Playground. This sentence was spoken by a model.',
    teaches:
      'The shortest useful run. Two sentences is enough to judge a voice, and cheap enough to try '
      + 'every one of them.'
  },
  {
    id: 'punctuation',
    label: 'Punctuation changes pacing',
    text:
      'Wait — are you certain? I asked twice; nobody answered. Well... perhaps they left. '
      + 'Perhaps, and this is the part I keep returning to, they never arrived at all.',
    teaches:
      'The same words with different punctuation are spoken differently. Dashes, semicolons, and '
      + 'ellipses become pauses of different lengths, because the model reads them as cues.'
  },
  {
    id: 'numbers',
    label: 'Numbers and abbreviations',
    text:
      'The meeting is on 3 March 2026 at 9:30 a.m. in Suite 4B. Dr. Reyes will cover items '
      + '1-3, then we break for 15 minutes.',
    teaches:
      'Text a model has to expand before it can speak. Listen for how it reads the date, the '
      + 'time, and the range — these are decisions, and models disagree about them.'
  },
  {
    id: 'tongue-twister',
    label: 'Hard to pronounce',
    text:
      'The sixth sick sheikh\u2019s sixth sheep\u2019s sick. Red leather, yellow leather. '
      + 'Unique New York, you know you need unique New York.',
    teaches:
      'Where synthesis audibly strains. Comparing two voices on this passage separates them far '
      + 'more clearly than a well-behaved sentence does.'
  }
];
