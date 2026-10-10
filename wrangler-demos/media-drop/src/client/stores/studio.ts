import { defineStore } from "pinia";
import { replaceMedia, type MediaItem } from "../media";
import {
  getErrorMessage,
  parseJsonOrEmpty,
  wrapOnProgress,
} from "../utils/defensive-guards";
import { valueOrDefault } from "@adrianhall/cloudflare-toolkit";

/** Progress callback invoked while an XMLHttpRequest upload transfers file bytes. */
export type UploadProgressHandler = (progress: number) => void;

/** Extract an RFC 9457 API error description when available. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: string;
  } | null;
  return body?.detail ?? `Request failed (${response.status}).`;
}

/** Owner-scoped studio data and commands backed by Cloudflare Access. */
export const useStudioStore = defineStore("studio", {
  state: () => ({
    /** Verified creator email displayed in the studio header. */
    email: "",
    /** Media belonging to the verified creator, including drafts. */
    media: [] as MediaItem[],
    /** Error suitable for a visible status message. */
    error: "",
    /** Whether an identity or listing request is in flight. */
    loading: false,
  }),
  actions: {
    /** Load the creator identity and their complete studio listing. */
    async load(): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const [identityResponse, mediaResponse] = await Promise.all([
          fetch("/api/studio/me"),
          fetch("/api/studio/media"),
        ]);
        if (!identityResponse.ok) {
          throw new Error(await responseMessage(identityResponse));
        }
        if (!mediaResponse.ok) {
          throw new Error(await responseMessage(mediaResponse));
        }
        const identity = (await identityResponse.json()) as { email: string };
        const body = (await mediaResponse.json()) as { media: MediaItem[] };
        this.email = identity.email;
        this.media = body.media;
      } catch (error) {
        this.error = getErrorMessage(error, "Could not load the studio.");
      } finally {
        this.loading = false;
      }
    },
    /** Stream a selected file to the Worker while reporting browser upload progress. */
    upload(
      title: string,
      file: File,
      onProgress: UploadProgressHandler,
    ): Promise<MediaItem> {
      this.error = "";
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/studio/media");
        request.setRequestHeader("Content-Type", file.type);
        request.setRequestHeader("X-Media-Title", title);
        request.upload.onprogress = (event) =>
          wrapOnProgress(onProgress, event);
        request.onerror = () =>
          reject(new Error("The upload could not reach Media Drop."));
        request.onload = () => {
          let body: { detail?: string; media?: MediaItem } = {};
          try {
            body = parseJsonOrEmpty<{ detail?: string; media?: MediaItem }>(
              request.responseText,
            );
          } catch {
            reject(new Error(`Upload failed (${request.status}).`));
            return;
          }
          if (request.status !== 201 || body.media === undefined) {
            reject(
              new Error(
                valueOrDefault(
                  body.detail,
                  `Upload failed (${request.status}).`,
                ),
              ),
            );
            return;
          }
          this.media.unshift(body.media);
          resolve(body.media);
        };
        request.send(file);
      });
    },
    /** Publish an owned draft and replace its local metadata. */
    async publish(id: string): Promise<void> {
      this.error = "";
      const response = await fetch(
        `/api/studio/media/${encodeURIComponent(id)}/publish`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        this.error = await responseMessage(response);
        return;
      }
      const body = (await response.json()) as { media: MediaItem };
      this.media = replaceMedia(this.media, id, body.media);
    },
    /** Delete an owned item and remove it from the local studio listing. */
    async remove(id: string): Promise<void> {
      this.error = "";
      const response = await fetch(
        `/api/studio/media/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        this.error = await responseMessage(response);
        return;
      }
      this.media = this.media.filter((item) => item.id !== id);
    },
    /** Record an owned media playback event without interrupting native playback. */
    async recordPlay(id: string): Promise<void> {
      await fetch(`/api/studio/media/${encodeURIComponent(id)}/play`, {
        keepalive: true,
        method: "POST",
      }).catch(() => undefined);
    },
  },
});
