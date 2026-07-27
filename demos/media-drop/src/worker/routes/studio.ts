import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { MediaRepository } from "../media/repository";
import {
  createMediaKey,
  deleteMedia,
  getMedia,
  putMedia,
} from "../media/storage";
import type { MediaItem } from "../media/types";
import { validateMediaId, validateUploadRequest } from "../media/validation";

/** Access-protected, owner-scoped media API mounted at `/api/studio`. */
export const studioRouter = new Hono<AppBindings>();

/** Return the verified creator identity for the studio application. */
studioRouter.get("/me", (context) => {
  return context.json({
    email: context.get("Cloudflare_Access_Identity").email,
  });
});

/** List drafts and published items belonging only to the verified creator. */
studioRouter.get("/media", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const repository = new MediaRepository(context.env.DB);
  return context.json({ media: await repository.listForOwner(owner) });
});

/** Stream an owned object, including a draft that is unavailable to the public library. */
studioRouter.get("/media/:id/content", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.getForOwner(
    owner,
    validateMediaId(context.req.param("id")),
  );
  const storedMedia = await getMedia(
    context.env.MEDIA,
    item.r2Key,
    context.req.raw,
    item.title,
  );
  if (storedMedia.preconditionFailed) {
    return new Response(null, { status: 412, headers: storedMedia.headers });
  }
  context.get("LOGGER").info("media_downloaded", {
    mediaId: item.id,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  });
  return new Response(storedMedia.body, {
    status: storedMedia.partial ? 206 : 200,
    headers: storedMedia.headers,
  });
});

/** Return metadata for one object owned by the verified creator. */
studioRouter.get("/media/:id", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.getForOwner(
    owner,
    validateMediaId(context.req.param("id")),
  );
  return context.json({ media: item });
});

/** Stream a new media request directly into R2, then persist its draft metadata in D1. */
studioRouter.post("/media", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const input = validateUploadRequest(context.req.raw);
  const id = crypto.randomUUID();
  const r2Key = await createMediaKey(owner, id);
  const sizeBytes = await putMedia(
    context.env.MEDIA,
    r2Key,
    input.body,
    input.contentType,
  );
  const timestamp = new Date().toISOString();
  const item: MediaItem = {
    id,
    owner,
    title: input.title,
    contentType: input.contentType,
    sizeBytes,
    r2Key,
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: null,
  };
  try {
    await new MediaRepository(context.env.DB).createDraft(item);
  } catch (error) {
    await deleteMedia(context.env.MEDIA, r2Key);
    throw error;
  }
  context.get("LOGGER").info("media_uploaded", {
    mediaId: item.id,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  });
  return context.json({ media: item }, 201);
});

/** Publish a draft owned by the verified creator. */
studioRouter.post("/media/:id/publish", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.publish(
    owner,
    validateMediaId(context.req.param("id")),
  );
  context.get("LOGGER").info("media_published", {
    mediaId: item.id,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  });
  return context.json({ media: item });
});

/** Delete an owned object from R2 first, then delete the corresponding D1 metadata. */
studioRouter.delete("/media/:id", async (context) => {
  const owner = context.get("Cloudflare_Access_Identity").email;
  const id = validateMediaId(context.req.param("id"));
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.getForOwner(owner, id);
  await deleteMedia(context.env.MEDIA, item.r2Key);
  await repository.deleteForOwner(owner, id);
  context.get("LOGGER").info("media_deleted", {
    mediaId: item.id,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  });
  return new Response(null, { status: 204 });
});
