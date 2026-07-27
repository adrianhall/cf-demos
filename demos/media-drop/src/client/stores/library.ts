import { defineStore } from "pinia";
import type { MediaItem } from "../media";
import { publicViewerUrl } from "../viewer";

/** Extract a useful API error message without assuming an RFC 9457 response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: string;
  } | null;
  return body?.detail ?? `Request failed (${response.status}).`;
}

/** Public library data loaded from the published-only API namespace. */
export const useLibraryStore = defineStore("library", {
  state: () => ({
    /** Latest published-media listing. */
    media: [] as MediaItem[],
    /** Error suitable for a visible status message. */
    error: "",
    /** Whether a public API request is currently in flight. */
    loading: false,
  }),
  actions: {
    /** Refresh the public library listing. */
    async load(): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch("/api/library");
        if (!response.ok) {
          throw new Error(await responseMessage(response));
        }
        const body = (await response.json()) as { media: MediaItem[] };
        this.media = body.media;
      } catch (error) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not load the library.";
      } finally {
        this.loading = false;
      }
    },
    /** Fetch one published item for the detail page. */
    async loadItem(id: string): Promise<MediaItem | null> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch(
          publicViewerUrl(`/api/library/${encodeURIComponent(id)}`),
        );
        if (!response.ok) {
          throw new Error(await responseMessage(response));
        }
        const body = (await response.json()) as { media: MediaItem };
        return body.media;
      } catch (error) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not load this media item.";
        return null;
      } finally {
        this.loading = false;
      }
    },
    /** Record a public playback event without interrupting the native media element. */
    async recordPlay(id: string): Promise<void> {
      await fetch(
        publicViewerUrl(`/api/library/${encodeURIComponent(id)}/play`),
        {
          keepalive: true,
          method: "POST",
        },
      ).catch(() => undefined);
    },
  },
});
