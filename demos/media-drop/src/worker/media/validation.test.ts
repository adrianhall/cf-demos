import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_SIZE_BYTES,
  validateMediaId,
  validateUploadRequest,
} from "./validation";

/** Create an upload request with safe defaults for header validation tests. */
function uploadRequest(headers: HeadersInit = {}): Request {
  return new Request("https://media.example/api/studio/media", {
    body: "media",
    headers: {
      "Content-Type": "image/png",
      "X-Media-Title": "Example image",
      ...headers,
    },
    method: "POST",
  });
}

describe("validateUploadRequest", () => {
  it("normalizes valid upload metadata", () => {
    expect(
      validateUploadRequest(
        uploadRequest({
          "Content-Length": "5",
          "Content-Type": "image/PNG; charset=utf-8",
        }),
      ),
    ).toMatchObject({
      contentLength: 5,
      contentType: "image/png",
      title: "Example image",
    });
  });

  it("rejects unapproved types and oversized declared uploads", () => {
    expect(() =>
      validateUploadRequest(
        uploadRequest({ "Content-Type": "application/pdf" }),
      ),
    ).toThrow();
    expect(() =>
      validateUploadRequest(
        uploadRequest({ "Content-Length": String(MAX_MEDIA_SIZE_BYTES + 1) }),
      ),
    ).toThrow();
    expect(() => validateUploadRequest(uploadRequest())).toThrow();
  });
});

describe("validateMediaId", () => {
  it("rejects malformed identifiers as not-found resources", () => {
    expect(() => validateMediaId("not-a-media-id")).toThrow();
    expect(validateMediaId("adf5b4e7-ae77-49d0-a9ee-d11aedf38d65")).toBe(
      "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    );
  });
});
