import { defineStore } from 'pinia';
import type { ImageMediaType } from '../../shared/images';
import { MAX_SPEECH_CHARACTERS } from '../../shared/read-text';

/**
 * A picture handed from one panel to another.
 */
export interface HandoffImage {
  /**
   * The bytes, base64-encoded.
   */
  base64: string;
  /**
   * Media type the server sniffed for the original image, used to build the preview URI.
   *
   * Typed as the renderable union rather than `string`, because this value ends up in a `data:` URI
   * and a `data:` URI's media type decides how the browser treats the payload. Narrowing it here
   * means a future caller cannot stage an arbitrary type without the compiler objecting; the
   * receiving panel re-checks at the point of use as well.
   */
  mediaType: ImageMediaType;
  /**
   * Size of the decoded picture in bytes.
   */
  byteLength: number;
  /**
   * Where the picture came from, shown so a visitor knows what they are about to describe.
   *
   * Phrased as provenance — "Generated in Create Image" — rather than as a file name, because there
   * is no file: the bytes never touched disk.
   */
  origin: string;
}

/**
 * Text handed from one panel to another.
 *
 * Added in phase 9 ahead of the panel that will produce it. Translate Text (phase 11) offers its
 * translation to Read Text, so the receiving half is built and tested now and the offering half is
 * one call when that panel lands. Defining the contract first is what keeps the two panels from
 * reaching into each other's component state, which is the shortcut this exists to foreclose.
 */
export interface HandoffText {
  /**
   * The text to carry over.
   *
   * Already truncated to what the receiving panel accepts; see {@link truncateForSpeech}. A handoff
   * that delivered more than the target panel can submit would arrive as a form that is invalid the
   * moment it is populated.
   */
  text: string;
  /**
   * Where the text came from, shown so a visitor knows what they are about to have read aloud.
   *
   * Phrased as provenance — "Translated into French" — rather than as a title, because there is no
   * document: the text was produced by a model moments ago.
   */
  origin: string;
  /**
   * Language code the text is in, when the offering panel knows it.
   *
   * Carried so Read Text can preselect a matching language on a model that has a language control,
   * which is the entire reason this handoff is worth having: a French translation read aloud by an
   * English voice is a worse result than no handoff at all. The receiving panel still checks the
   * code against the selected model's published list rather than trusting it.
   */
  language?: string;
  /**
   * Whether the text was shortened to fit the receiving panel's limit.
   *
   * Reported rather than silently applied, so the panel can say that some of the translation was
   * left behind instead of appearing to have mis-read it.
   */
  truncated: boolean;
}

/**
 * Shortens text to what the Read Text panel will accept.
 *
 * Exported and shared so the offering panel and the receiving panel agree on where the cut falls,
 * rather than each applying its own rule and disagreeing about whether anything was lost.
 *
 * The cut is made at a word boundary where one is available in the final stretch of the allowance,
 * because a passage ending mid-word is read aloud as a mispronounced fragment — the one place this
 * truncation becomes audible rather than merely visible.
 *
 * @param text Text the offering panel produced.
 * @returns The text to carry and whether anything was removed.
 */
export function truncateForSpeech(text: string): { text: string; truncated: boolean } {
  // Counted in code points, matching the server's own limit, so a non-BMP character counts once
  // rather than twice and the two cannot disagree about whether a passage fits.
  const characters = [...text];
  if (characters.length <= MAX_SPEECH_CHARACTERS) {
    return { text, truncated: false };
  }

  const clipped = characters.slice(0, MAX_SPEECH_CHARACTERS).join('');
  const lastSpace = clipped.lastIndexOf(' ');

  // Only honoured when the boundary is near the end. A text with no spaces at all — or one whose
  // only space is in its first few words, as in some scripts — would otherwise be cut to almost
  // nothing in the name of tidiness.
  const atWordBoundary = lastSpace > MAX_SPEECH_CHARACTERS * 0.9;

  return { text: atWordBoundary ? clipped.slice(0, lastSpace) : clipped, truncated: true };
}

/**
 * Content in transit between panels.
 *
 * Exists so Create Image can offer "describe this", and so Translate Text can offer "read this
 * aloud", without any panel importing another. The alternative — passing megabytes of base64, or a
 * visitor's text, through a route query parameter — would put the content in browser history and in
 * any intermediary's logs, which is precisely what this demo avoids doing with a prompt.
 *
 * Deliberately single-slot per kind and consumed on read. A handoff is a one-time intent, and
 * leaving the previous one behind would let a visitor return to the panel later and find stale
 * content waiting, which looks like a bug and quietly retains data nobody asked to keep.
 *
 * Images and text occupy separate slots rather than one union-typed slot. They are consumed by
 * different panels, so a single slot would mean an uncollected picture silently discarding a
 * translation — a cross-panel interaction with no reason to exist.
 */
export const useHandoffStore = defineStore('handoff', {
  actions: {
    /**
     * Offers a picture to the next panel.
     *
     * @param image The picture to hand over.
     * @returns Nothing; any previously pending image handoff is replaced.
     */
    offer(image: HandoffImage): void {
      this.pending = image;
    },
    /**
     * Takes the pending picture, clearing it.
     *
     * Clearing on read is what makes this a handoff rather than a cache: the receiving panel gets
     * the picture exactly once, so navigating away and back does not silently re-load it.
     *
     * @returns The pending picture, or `undefined` when none was offered.
     */
    take(): HandoffImage | undefined {
      const pending = this.pending;
      this.pending = undefined;
      return pending ?? undefined;
    },
    /**
     * Offers text to the next panel, shortening it to what that panel accepts.
     *
     * The truncation happens here rather than at the receiving end so that a caller cannot offer
     * text the target panel would refuse. The result records whether anything was removed, so the
     * receiving panel can say so.
     *
     * @param offer The text, its provenance, and its language when known.
     * @returns Nothing; any previously pending text handoff is replaced.
     */
    offerText(offer: Omit<HandoffText, 'truncated'>): void {
      const { text, truncated } = truncateForSpeech(offer.text);
      this.pendingText = { ...offer, text, truncated };
    },
    /**
     * Takes the pending text, clearing it.
     *
     * @returns The pending text, or `undefined` when none was offered.
     */
    takeText(): HandoffText | undefined {
      const pending = this.pendingText;
      this.pendingText = undefined;
      return pending ?? undefined;
    }
  },
  state: (): { pending: HandoffImage | undefined; pendingText: HandoffText | undefined } => ({
    /**
     * The picture awaiting collection, or `undefined`.
     */
    pending: undefined,
    /**
     * The text awaiting collection, or `undefined`.
     */
    pendingText: undefined
  })
});
