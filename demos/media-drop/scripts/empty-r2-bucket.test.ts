import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyR2Bucket } from "./empty-r2-bucket";

describe("emptyR2Bucket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the ordinary deployment token with the bucket-empty endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await emptyR2Bucket({
      accountId: "account-id",
      apiToken: "token",
      bucketName: "media bucket",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/r2/buckets/media%20bucket/objects?prefix=",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
        method: "DELETE",
      }),
    );
  });

  it("fails when Cloudflare rejects the deletion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    );

    await expect(
      emptyR2Bucket({
        accountId: "account-id",
        apiToken: "token",
        bucketName: "media",
      }),
    ).rejects.toThrow("HTTP 403");
  });
});
