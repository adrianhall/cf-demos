import type { MediaRepository } from "./repository";
import { deleteMedia } from "./storage";
import type { MediaItem } from "./types";

/**
 * Persist metadata after an R2 upload, deleting the object when D1 rejects the new draft.
 *
 * @param repository D1 repository that persists the draft metadata.
 * @param bucket R2 bucket containing the newly stored object.
 * @param item Draft metadata whose `r2Key` identifies the object to compensate for.
 * @returns Resolves after D1 persists the metadata.
 * @throws Rethrows the D1 persistence error after deleting the R2 object.
 */
export async function persistDraftMetadata(
  repository: Pick<MediaRepository, "createDraft">,
  bucket: R2Bucket,
  item: MediaItem,
): Promise<void> {
  try {
    await repository.createDraft(item);
  } catch (error) {
    await deleteMedia(bucket, item.r2Key);
    throw error;
  }
}
