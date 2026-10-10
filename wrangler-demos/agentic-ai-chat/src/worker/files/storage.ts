/**
 * R2 persistence for agent-generated files (docs/06-AGENTIC-CHAT.md Section 6.7, Phase 9, US-8).
 * `writeMarkdown` deliberately does **not** run through the Dynamic Worker/egress-gateway
 * mechanism Phase 10's `getUrl` tool needs: it writes model-generated text to R2 through a
 * binding the main Worker already trusts, with no untrusted network egress to control -- routing
 * it through a sandbox would add ceremony with no corresponding security benefit (Section 6.7).
 */

/**
 * Build this file's R2 object key, namespaced under the owning chat so every one of a chat's
 * files (and nothing else) shares a common prefix. `fileId` is a server-generated UUID
 * (`../agent/tools/write-markdown.ts`), never client- or model-supplied input, so this key can
 * never be made to collide with, or escape into, another chat's own prefix.
 *
 * @param chatId The owning chat's id.
 * @param fileId The file's own server-generated id.
 * @returns The R2 object key to store/read this file's content under.
 */
export function chatFileKey(chatId: string, fileId: string): string {
  return `chats/${chatId}/files/${fileId}.md`;
}

/**
 * Store one file's Markdown content in R2. Always called **before** the corresponding
 * `chat_files` D1 row is inserted (docs/06-AGENTIC-CHAT.md Section 11's ordering requirement --
 * "a partial failure never leaves a downloadable file the app cannot see"): a D1 insert that
 * later fails leaves an orphaned R2 object, which {@link deleteChatFile} then compensates for,
 * rather than the reverse (a D1 row with no backing object, which no ordering can recover from).
 *
 * @param bucket R2 bucket binding (`FILES`).
 * @param key Destination object key (`chatFileKey()`).
 * @param content Already-validated Markdown content (`../files/validation.ts`'s
 * `validateMarkdownContent()`).
 */
export async function putChatFile(
  bucket: R2Bucket,
  key: string,
  content: string,
): Promise<void> {
  await bucket.put(key, content, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
}

/**
 * Read one file's content and metadata back from R2 for `GET /api/chats/:id/files/:fileId`
 * (already ownership-checked by that route's own D1 lookup before this is ever called).
 *
 * @param bucket R2 bucket binding.
 * @param key The file's own R2 key (from its `chat_files` row).
 * @returns The R2 object, or `null` if it no longer exists (a `chat_files` row whose object was
 * removed some other way -- tolerated the same way a deleted-mid-turn chat is tolerated
 * elsewhere in this demo, docs/06-AGENTIC-CHAT.md Section 11).
 */
export async function getChatFile(
  bucket: R2Bucket,
  key: string,
): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

/**
 * Delete an R2 object. Used only to compensate for a `chat_files` D1 insert that fails after a
 * successful R2 write (Section 11) -- normal reads never delete anything.
 *
 * @param bucket R2 bucket binding.
 * @param key The object key to remove.
 */
export async function deleteChatFile(
  bucket: R2Bucket,
  key: string,
): Promise<void> {
  await bucket.delete(key);
}

/**
 * Build an RFC 5987 `Content-Disposition` header value for downloading a file under its
 * sanitized filename -- mirrors `demos/media-drop/src/worker/media/storage.ts`'s own
 * `contentDisposition()` helper.
 *
 * @param filename The file's already-sanitized filename (`../files/validation.ts`).
 * @returns The header value, forcing a browser download (this route has no inline-preview use
 * case, unlike media-drop's audio/video/image content).
 */
export function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
