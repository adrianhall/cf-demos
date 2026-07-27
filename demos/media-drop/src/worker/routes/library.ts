import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { toPublicMediaItem, MediaRepository } from "../media/repository";
import { getMedia } from "../media/storage";
import { validateMediaId } from "../media/validation";
import { anonymousViewer } from "../media/viewer";

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
  context.get("LOGGER").info("media_viewed_info", {
    mediaId: item.id,
    user: anonymousViewer(context.req.raw),
  });
  return context.json({ media: toPublicMediaItem(item) });
});

/** Record an actual public audio or video play after confirming the item is published. */
libraryRouter.post("/:id/play", async (context) => {
  const item = await new MediaRepository(context.env.DB).getPublished(
    validateMediaId(context.req.param("id")),
  );
  context.get("LOGGER").info("media_played", {
    mediaId: item.id,
    user: anonymousViewer(context.req.raw),
  });
  return new Response(null, { status: 204 });
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
  if (storedMedia.conditionalStatus !== null) {
    return new Response(null, {
      status: storedMedia.conditionalStatus,
      headers: storedMedia.headers,
    });
  }
  context.get("LOGGER").info("media_downloaded", {
    mediaId: item.id,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    user: anonymousViewer(context.req.raw),
  });
  return new Response(storedMedia.body, {
    status: storedMedia.partial ? 206 : 200,
    headers: storedMedia.headers,
  });
});
