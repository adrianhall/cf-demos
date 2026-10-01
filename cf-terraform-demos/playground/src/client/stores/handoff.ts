import { defineStore } from 'pinia';
import type { ImageMediaType } from '../../images';

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
 * A picture in transit between panels.
 *
 * Exists so Create Image can offer "describe this" without either panel importing the other. The
 * alternative — passing megabytes of base64 through a route query parameter — would put the image
 * in browser history and in any intermediary's logs, which is precisely what this demo avoids doing
 * with a prompt.
 *
 * Deliberately single-slot and consumed on read. A handoff is a one-time intent, and leaving the
 * previous one behind would let a visitor return to the panel weeks later and find a stale picture
 * waiting, which looks like a bug and quietly retains data nobody asked to keep.
 */
export const useHandoffStore = defineStore('handoff', {
  actions: {
    /**
     * Offers a picture to the next panel.
     *
     * @param image The picture to hand over.
     * @returns Nothing; any previously pending handoff is replaced.
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
    }
  },
  state: (): { pending: HandoffImage | undefined } => ({
    /**
     * The picture awaiting collection, or `undefined`.
     */
    pending: undefined
  })
});
