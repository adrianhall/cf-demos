import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { beforeAll, describe, expect, it } from "vitest";

/** Test-only bindings added by the integration Vitest configuration. */
interface TestEnv extends Env {
  /** Parsed migration files used to initialize Miniflare D1. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Construct a studio request carrying a development Access identity. */
async function studioRequest(
  email: string,
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, await signDevJwt(email));
  return new Request(`https://media.example${path}`, { ...init, headers });
}

/** Upload a small valid image and return the owner-only media response. */
async function uploadDraft(email: string): Promise<{
  id: string;
  r2Key: string;
  status: "draft";
}> {
  const body = "draft bytes";
  const response = await exports.default.fetch(
    await studioRequest(email, "/api/studio/media", {
      body,
      headers: {
        "Content-Length": String(body.length),
        "Content-Type": "image/png",
        "X-Media-Title": "Private image",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(201);
  return (
    (await response.json()) as {
      media: { id: string; r2Key: string; status: "draft" };
    }
  ).media;
}

/** Integration tests run against real Miniflare D1 and R2 bindings. */
describe("Media Drop Worker", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it.each([
    ["GET", "/api/studio/me"],
    ["GET", "/api/studio/media"],
    ["POST", "/api/studio/media"],
    ["GET", "/api/studio/media/adf5b4e7-ae77-49d0-a9ee-d11aedf38d65"],
    ["GET", "/api/studio/media/adf5b4e7-ae77-49d0-a9ee-d11aedf38d65/content"],
    ["POST", "/api/studio/media/adf5b4e7-ae77-49d0-a9ee-d11aedf38d65/publish"],
    ["DELETE", "/api/studio/media/adf5b4e7-ae77-49d0-a9ee-d11aedf38d65"],
  ])("rejects unauthenticated %s %s", async (method, path) => {
    const response = await exports.default.fetch(
      new Request(`https://media.example${path}`, { method }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("keeps a draft private, permits the owner stream, and prevents another creator from accessing it", async () => {
    const draft = await uploadDraft("owner-draft@example.com");

    const identity = await exports.default.fetch(
      await studioRequest("owner-draft@example.com", "/api/studio/me"),
    );
    expect(await identity.json()).toEqual({ email: "owner-draft@example.com" });

    const ownerMetadata = await exports.default.fetch(
      await studioRequest(
        "owner-draft@example.com",
        `/api/studio/media/${draft.id}`,
      ),
    );
    expect(await ownerMetadata.json()).toMatchObject({
      media: { id: draft.id },
    });

    const publicList = await exports.default.fetch(
      new Request("https://media.example/api/library"),
    );
    expect(await publicList.json()).toEqual({ media: [] });

    for (const path of [
      `/api/library/${draft.id}`,
      `/api/library/${draft.id}/content`,
    ]) {
      expect(
        (
          await exports.default.fetch(
            new Request(`https://media.example${path}`),
          )
        ).status,
      ).toBe(404);
    }

    const ownerContent = await exports.default.fetch(
      await studioRequest(
        "owner-draft@example.com",
        `/api/studio/media/${draft.id}/content`,
      ),
    );
    expect(ownerContent.status).toBe(200);
    expect(new TextDecoder().decode(await ownerContent.arrayBuffer())).toBe(
      "draft bytes",
    );

    const ownerConditional = await exports.default.fetch(
      await studioRequest(
        "owner-draft@example.com",
        `/api/studio/media/${draft.id}/content`,
        {
          headers: { "If-None-Match": ownerContent.headers.get("etag") ?? "" },
        },
      ),
    );
    expect(ownerConditional.status).toBe(304);

    const ownerRange = await exports.default.fetch(
      await studioRequest(
        "owner-draft@example.com",
        `/api/studio/media/${draft.id}/content`,
        { headers: { Range: "bytes=0-4" } },
      ),
    );
    expect(ownerRange.status).toBe(206);
    expect(ownerRange.headers.get("content-range")).toBe("bytes 0-4/11");

    const ownerPlay = await exports.default.fetch(
      await studioRequest(
        "owner-draft@example.com",
        `/api/studio/media/${draft.id}/play`,
        { method: "POST" },
      ),
    );
    expect(ownerPlay.status).toBe(204);

    const otherList = await exports.default.fetch(
      await studioRequest("other-creator@example.com", "/api/studio/media"),
    );
    expect(await otherList.json()).toEqual({ media: [] });

    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/content"],
      ["POST", "/publish"],
      ["DELETE", ""],
    ]) {
      const response = await exports.default.fetch(
        await studioRequest(
          "other-creator@example.com",
          `/api/studio/media/${draft.id}${suffix}`,
          { method },
        ),
      );
      expect(response.status).toBe(404);
    }
  });

  it("publishes an owned draft for the library then deletes its R2 object and D1 row", async () => {
    const draft = await uploadDraft("owner-publish@example.com");

    const publishResponse = await exports.default.fetch(
      await studioRequest(
        "owner-publish@example.com",
        `/api/studio/media/${draft.id}/publish`,
        { method: "POST" },
      ),
    );
    expect(publishResponse.status).toBe(200);
    expect(await publishResponse.json()).toMatchObject({
      media: { id: draft.id, status: "published" },
    });

    const repeatPublish = await exports.default.fetch(
      await studioRequest(
        "owner-publish@example.com",
        `/api/studio/media/${draft.id}/publish`,
        { method: "POST" },
      ),
    );
    expect(await repeatPublish.json()).toMatchObject({
      media: { id: draft.id, status: "published" },
    });

    const publicMetadata = await exports.default.fetch(
      new Request(`https://media.example/api/library/${draft.id}`),
    );
    expect(await publicMetadata.json()).toMatchObject({
      media: { id: draft.id, status: "published" },
    });

    const publicContent = await exports.default.fetch(
      new Request(
        `https://media.example/api/library/${draft.id}/content?download=1`,
      ),
    );
    expect(publicContent.status).toBe(200);
    expect(publicContent.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(new TextDecoder().decode(await publicContent.arrayBuffer())).toBe(
      "draft bytes",
    );

    const publicConditional = await exports.default.fetch(
      new Request(`https://media.example/api/library/${draft.id}/content`, {
        headers: { "If-None-Match": publicContent.headers.get("etag") ?? "" },
      }),
    );
    expect(publicConditional.status).toBe(304);

    const publicRange = await exports.default.fetch(
      new Request(`https://media.example/api/library/${draft.id}/content`, {
        headers: { Range: "bytes=0-4" },
      }),
    );
    expect(publicRange.status).toBe(206);
    expect(publicRange.headers.get("content-range")).toBe("bytes 0-4/11");

    const publicPlay = await exports.default.fetch(
      new Request(`https://media.example/api/library/${draft.id}/play`, {
        method: "POST",
      }),
    );
    expect(publicPlay.status).toBe(204);

    const deletion = await exports.default.fetch(
      await studioRequest(
        "owner-publish@example.com",
        `/api/studio/media/${draft.id}`,
        { method: "DELETE" },
      ),
    );
    expect(deletion.status).toBe(204);
    await expect(env.MEDIA.get(draft.r2Key)).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT id FROM media WHERE id = ?")
        .bind(draft.id)
        .first(),
    ).resolves.toBeNull();
  });
});
