/**
 * A short link persisted in Workers KV.
 */
export interface ShortLink {
  /**
   * Immutable URL-safe identifier used in `/l/:code`.
   */
  code: string;
  /**
   * Validated absolute HTTP(S) destination.
   */
  destination: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp for the most recent destination update.
   */
  updatedAt: string;
}

/**
 * Value duplicated in KV metadata to make administrative listing efficient.
 */
export interface LinkMetadata {
  /**
   * Validated absolute HTTP(S) destination.
   */
  destination: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp for the most recent destination update.
   */
  updatedAt: string;
}

/**
 * JSON body accepted when creating or updating a short link.
 */
export interface LinkInput {
  /**
   * Normalized absolute HTTP(S) redirect destination.
   */
  destination: string;
}

/**
 * Persistence port owned by the application layer, not by HTTP routes.
 */
export interface LinkRepository {
  /**
   * Persist a newly allocated short link.
   *
   * @param input Validated redirect destination to store.
   * @returns The persisted link, including its generated immutable short code.
   * @throws {Error} When persistence cannot allocate or write the link.
   */
  create(input: LinkInput): Promise<ShortLink>;

  /**
   * Remove the link identified by a validated short code.
   *
   * @param code Validated short code to delete.
   * @returns A promise fulfilled when the link no longer exists in the repository.
   * @throws {ProblemDetailsError} When the code does not identify a stored link.
   * @throws {Error} When persistence rejects the deletion.
   */
  delete(code: string): Promise<void>;

  /**
   * Read one link.
   *
   * @param code Validated short code to retrieve.
   * @returns The stored link.
   * @throws {ProblemDetailsError} When the code does not identify a stored link.
   * @throws {Error} When persistence rejects the read.
   */
  get(code: string): Promise<ShortLink>;

  /**
   * List all links available to the administrator.
   *
   * @returns Links ordered by most recently updated first.
   * @throws {Error} When persistence rejects the list request.
   */
  list(): Promise<ShortLink[]>;

  /**
   * Replace the redirect destination while preserving a link's code and creation time.
   *
   * @param code Validated short code to update.
   * @param input Validated replacement redirect destination.
   * @returns The updated stored link.
   * @throws {ProblemDetailsError} When the code does not identify a stored link.
   * @throws {Error} When persistence rejects the read or write.
   */
  update(code: string, input: LinkInput): Promise<ShortLink>;
}
