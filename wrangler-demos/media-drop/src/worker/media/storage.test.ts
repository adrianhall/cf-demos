import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMedia,
  createMediaKey,
  putMedia,
  resolveRequestedRange,
} from "./storage";

describe("createMediaKey", () => {
  it("uses a stable hash rather than the owner's email in an R2 key", async () => {
    const id = "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65";
    const key = await createMediaKey("creator@example.com", id);

    expect(key).toMatch(new RegExp(`^media/[0-9a-f]{64}/${id}$`, "u"));
    expect(key).not.toContain("creator@example.com");
    await expect(createMediaKey("creator@example.com", id)).resolves.toBe(key);
  });
});

describe("resolveRequestedRange", () => {
  it("resolves bounded, open-ended, and suffix byte ranges", () => {
    expect(resolveRequestedRange("bytes=10-19", 100)).toEqual({
      offset: 10,
      length: 10,
    });
    expect(resolveRequestedRange("bytes=90-", 100)).toEqual({
      offset: 90,
      length: 10,
    });
    expect(resolveRequestedRange("bytes=-10", 100)).toEqual({
      offset: 90,
      length: 10,
    });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(resolveRequestedRange(null, 100)).toBeNull();
    expect(resolveRequestedRange("bytes=90-10", 100)).toBeNull();
    expect(resolveRequestedRange("bytes=-0", 100)).toBeNull();
  });
});

describe("getMedia", () => {
  it("returns not found when D1 metadata points at an absent object", async () => {
    const bucket = { get: async () => null } as unknown as R2Bucket;

    await expect(
      getMedia(
        bucket,
        "missing",
        new Request("https://media.example/content"),
        "Missing",
      ),
    ).rejects.toThrow("Media not found.");
  });

  it("maps failed cache and precondition requests to HTTP statuses", async () => {
    const object = {
      httpEtag: "etag",
      size: 10,
      writeHttpMetadata: (headers: Headers) =>
        headers.set("Content-Type", "image/png"),
    };
    const bucket = { get: async () => object } as unknown as R2Bucket;

    await expect(
      getMedia(
        bucket,
        "object",
        new Request("https://media.example/content", {
          headers: { "If-None-Match": "etag" },
        }),
        "Image",
      ),
    ).resolves.toMatchObject({ conditionalStatus: 304 });
    await expect(
      getMedia(
        bucket,
        "object",
        new Request("https://media.example/content", {
          headers: { "If-Match": "other" },
        }),
        "Image",
      ),
    ).resolves.toMatchObject({ conditionalStatus: 412 });
  });

  it("rejects an inconsistent R2 range response", async () => {
    const object = {
      body: new ReadableStream(),
      httpEtag: "etag",
      size: 10,
      writeHttpMetadata: (headers: Headers) =>
        headers.set("Content-Type", "image/png"),
    };
    const bucket = { get: async () => object } as unknown as R2Bucket;

    await expect(
      getMedia(
        bucket,
        "object",
        new Request("https://media.example/content", {
          headers: { Range: "bytes=10-20" },
        }),
        "Image",
      ),
    ).rejects.toThrow("Media range could not be resolved.");
  });
});

describe("putMedia", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("raises a problem when R2 does not return stored object metadata", async () => {
    class FixedLengthStreamStub {
      /** Readable side passed to the R2 binding. */
      readonly readable: ReadableStream;
      /** Writable side fed by the request body. */
      readonly writable: WritableStream;

      /** Use a standard transform stream to simulate the Workers stream contract. */
      constructor() {
        const stream = new TransformStream();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    }

    vi.stubGlobal("FixedLengthStream", FixedLengthStreamStub);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const bucket = {
      put: async (_key: string, value: ReadableStream) => {
        await new Response(value).arrayBuffer();
        return null;
      },
    } as unknown as R2Bucket;

    await expect(
      putMedia(bucket, "media/key", body, "image/png", 1),
    ).rejects.toThrow("Media could not be stored.");
  });
});
