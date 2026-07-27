/** Browser storage key for Media Drop's opaque public-viewer identifier. */
const viewerStorageKey = "media-drop.viewer-id";

/**
 * Return a persisted random identifier for anonymous public activity.
 *
 * @returns An opaque UUID that contains no personal information.
 */
export function anonymousViewerId(): string {
  const existing = localStorage.getItem(viewerStorageKey);
  if (existing !== null) {
    return existing;
  }
  const viewerId = crypto.randomUUID();
  localStorage.setItem(viewerStorageKey, viewerId);
  return viewerId;
}

/**
 * Add the anonymous identifier to a public API URL for structured Worker logging.
 *
 * @param path Root-relative public API path.
 * @returns Root-relative URL carrying the opaque viewer token.
 */
export function publicViewerUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("viewer", anonymousViewerId());
  return `${url.pathname}${url.search}`;
}
