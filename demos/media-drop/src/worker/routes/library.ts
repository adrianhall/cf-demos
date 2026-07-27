import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { toPublicMediaItem, MediaRepository } from "../media/repository";
import { getMedia } from "../media/storage";
import { validateMediaId } from "../media/validation";

/** Public, read-only published-media API mounted at `/api/library`. */
export const libraryRouter = new Hono<AppBindings>();

/** List published items without exposing owner identities or R2 object keys. */
libraryRouter.get("/", async (context) => {
  const repository = new MediaRepository(context.env.DB);
  return context.json({ media: await repository.listPublished() });
});

/** Return metadata only for an item that has been published. */
libraryRouter.get("/:id", async (context) => {
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.getPublished(
    validateMediaId(context.req.param("id")),
  );
  return context.json({ media: toPublicMediaItem(item) });
});

/** Stream a published object, honoring R2's byte-range and conditional request handling. */
libraryRouter.get("/:id/content", async (context) => {
  const repository = new MediaRepository(context.env.DB);
  const item = await repository.getPublished(
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
