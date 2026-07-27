import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioStore } from "./studio";

/** One owner-scoped item used by Studio store tests. */
const item = {
  contentType: "image/png",
  createdAt: "2026-07-27T12:00:00.000Z",
  id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
  publishedAt: null,
  sizeBytes: 12,
  status: "draft" as const,
  title: "Private image",
  updatedAt: "2026-07-27T12:00:00.000Z",
};

/** XMLHttpRequest test double that completes uploads with configured API output. */
class UploadRequest {
  /** Most recently created upload request. */
  static latest: UploadRequest | undefined;
  /** Whether the next simulated request should fail before receiving a response. */
  static failNext = false;
  /** Status returned by the next simulated upload. */
  static nextStatus = 201;
  /** Response body returned by the next simulated upload. */
  static nextResponseText = JSON.stringify({ media: item });
  /** Callback fired by the browser upload progress event. */
  readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
  /** HTTP status returned to the store. */
  status = UploadRequest.nextStatus;
  /** Serialized response returned to the store. */
  responseText = UploadRequest.nextResponseText;
  /** Callback fired when the simulated request completes. */
  onload: (() => void) | null = null;
  /** Callback fired when the simulated request cannot reach the Worker. */
  onerror: (() => void) | null = null;

  /** Save the instance so tests can control its lifecycle. */
  constructor() {
    UploadRequest.latest = this;
  }

  /** Request setup is asserted through the completed behavior, not internal calls. */
  open(): void {}

  /** Request setup is asserted through the completed behavior, not internal calls. */
  setRequestHeader(): void {}

  /** Complete the upload, including a measurable progress event. */
  send(): void {
    if (UploadRequest.failNext) {
      UploadRequest.failNext = false;
      this.onerror?.();
      return;
    }
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 6,
      total: 12,
    } as ProgressEvent);
    this.onload?.();
  }
}

describe("studio store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads the verified identity and owner-scoped media", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ email: "creator@example.com" }))
        .mockResolvedValueOnce(Response.json({ media: [item] })),
    );
    const store = useStudioStore();

    await store.load();

    expect(store.email).toBe("creator@example.com");
    expect(store.media).toEqual([item]);
    expect(store.loading).toBe(false);
  });

  it("reports failed identity requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad response", { status: 401 })),
    );
    const store = useStudioStore();

    await store.load();

    expect(store.error).toBe("Request failed (401).");
    expect(store.loading).toBe(false);
  });

  it("reports a failed owner-media response after identity verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ email: "creator@example.com" }))
        .mockResolvedValueOnce(
          Response.json({ detail: "Media unavailable" }, { status: 503 }),
        ),
    );
    const store = useStudioStore();

    await store.load();

    expect(store.error).toBe("Media unavailable");
    expect(store.loading).toBe(false);
  });

  it("uploads a draft, reports progress, and prepends its media", async () => {
    const store = useStudioStore();
    const progress = vi.fn();

    await expect(
      store.upload(
        "Private image",
        new File(["image bytes"], "private.png", { type: "image/png" }),
        progress,
      ),
    ).resolves.toEqual(item);

    expect(progress).toHaveBeenCalledWith(50);
    expect(store.media).toEqual([item]);
  });

  it("rejects malformed and unsuccessful upload responses", async () => {
    const store = useStudioStore();
    UploadRequest.nextResponseText = "{";
    await expect(
      store.upload(
        "Private image",
        new File(["image bytes"], "private.png", { type: "image/png" }),
        vi.fn(),
      ),
    ).rejects.toThrow("Upload failed (201).");

    UploadRequest.nextStatus = 413;
    UploadRequest.nextResponseText = JSON.stringify({
      detail: "Media too large",
    });
    await expect(
      store.upload(
        "Private image",
        new File(["image bytes"], "private.png", { type: "image/png" }),
        vi.fn(),
      ),
    ).rejects.toThrow("Media too large");
    UploadRequest.nextStatus = 201;
    UploadRequest.nextResponseText = JSON.stringify({ media: item });
  });

  it("records upload errors and mutates local media after publish or delete", async () => {
    const store = useStudioStore();
    UploadRequest.failNext = true;
    await expect(
      store.upload(
        "Private image",
        new File(["image bytes"], "private.png", { type: "image/png" }),
        vi.fn(),
      ),
    ).rejects.toThrow("could not reach");

    store.media = [item];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ media: { ...item, status: "published" } }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockRejectedValueOnce(new Error("telemetry unavailable")),
    );

    await store.publish(item.id);
    expect(store.media[0]?.status).toBe("published");
    await store.remove(item.id);
    expect(store.media).toEqual([]);
    await expect(store.recordPlay(item.id)).resolves.toBeUndefined();
  });

  it("retains local media and reports failed publish or delete requests", async () => {
    const store = useStudioStore();
    store.media = [item];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ detail: "Cannot publish" }, { status: 409 }),
        )
        .mockResolvedValueOnce(
          Response.json({ detail: "Cannot delete" }, { status: 409 }),
        ),
    );

    await store.publish(item.id);
    expect(store.error).toBe("Cannot publish");
    expect(store.media).toEqual([item]);

    await store.remove(item.id);
    expect(store.error).toBe("Cannot delete");
    expect(store.media).toEqual([item]);
  });
});
