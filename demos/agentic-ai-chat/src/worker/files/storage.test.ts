import { describe, expect, it, vi } from "vitest";
import {
  chatFileKey,
  contentDisposition,
  deleteChatFile,
  getChatFile,
  putChatFile,
} from "./storage";

describe("chatFileKey", () => {
  it("namespaces the key under the owning chat's own prefix", () => {
    expect(chatFileKey("chat-1", "file-1")).toBe(
      "chats/chat-1/files/file-1.md",
    );
  });
});

describe("putChatFile", () => {
  it("writes the content to R2 with a Markdown content type", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;

    await putChatFile(bucket, "chats/chat-1/files/file-1.md", "# Hello");

    expect(put).toHaveBeenCalledWith(
      "chats/chat-1/files/file-1.md",
      "# Hello",
      {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      },
    );
  });
});

describe("getChatFile", () => {
  it("returns the R2 object when it exists", async () => {
    const object = { body: new ReadableStream() };
    const bucket = {
      get: vi.fn().mockResolvedValue(object),
    } as unknown as R2Bucket;

    await expect(getChatFile(bucket, "key")).resolves.toBe(object);
  });

  it("returns null when the object no longer exists", async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;

    await expect(getChatFile(bucket, "key")).resolves.toBeNull();
  });
});

describe("deleteChatFile", () => {
  it("deletes the object", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const bucket = { delete: del } as unknown as R2Bucket;

    await deleteChatFile(bucket, "key");

    expect(del).toHaveBeenCalledWith("key");
  });
});

describe("contentDisposition", () => {
  it("forces a download under the exact filename, percent-encoded", () => {
    expect(contentDisposition("trip itinerary.md")).toBe(
      "attachment; filename*=UTF-8''trip%20itinerary.md",
    );
  });
});
