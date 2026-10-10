import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { LinkInput, LinkMetadata, ShortLink } from "./types";
import { CODE_PATTERN } from "./validation";

const CODE_LENGTH_BYTES = 9;
const LINK_PREFIX = "link:";
const MAX_CREATE_ATTEMPTS = 5;

/**
 * Repository for short-link persistence in Workers KV. Encapsulates the KV key
 * namespace, the listable-metadata duplication used by {@link LinkRepository.list}, and
 * generated-code collision handling, so callers (Hono routers, tests) only ever deal in
 * {@link ShortLink} values and validated input.
 */
export class LinkRepository {
  /**
   * @param namespace Workers KV namespace bound to this Worker (`env.LINKS`).
   */
  constructor(private readonly namespace: KVNamespace) {}

  /** Namespaced KV key for a short code. */
  private key(code: string): string {
    return `${LINK_PREFIX}${code}`;
  }

  /** Encode cryptographically secure bytes as an unpadded URL-safe token. */
  private static generateCode(): string {
    const bytes = new Uint8Array(CODE_LENGTH_BYTES);
    crypto.getRandomValues(bytes);
    let value = "";
    for (const byte of bytes) {
      value += String.fromCharCode(byte);
    }
    return btoa(value)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }

  /**
   * Decode and verify a short-link record read from Workers KV.
   *
   * @param code Code that identified the KV record.
   * @param value JSON value from Workers KV.
   * @returns Decoded short link.
   * @throws {ProblemDetailsError} When the record does not exist or is malformed.
   */
  private parseStoredLink(code: string, value: string | null): ShortLink {
    if (value === null) {
      throw notFound({ detail: "Short link not found." });
    }

    try {
      const parsed = JSON.parse(value) as Partial<ShortLink>;
      if (
        parsed.code !== code ||
        typeof parsed.destination !== "string" ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.updatedAt !== "string"
      ) {
        throw new Error("Stored link shape is invalid.");
      }
      return parsed as ShortLink;
    } catch {
      throw notFound({ detail: "Short link not found." });
    }
  }

  /**
   * Persist a short-link record with listable metadata.
   *
   * @param link Link to persist.
   * @returns Promise resolved after KV accepts the write.
   */
  private async save(link: ShortLink): Promise<void> {
    const metadata: LinkMetadata = {
      destination: link.destination,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
    await this.namespace.put(this.key(link.code), JSON.stringify(link), {
      metadata,
    });
  }

  /**
   * Create a link with a collision-resistant generated code.
   *
   * @param input Validated destination input.
   * @returns Newly persisted short link.
   * @throws {Error} When an extremely unlikely repeated collision occurs.
   */
  async create(input: LinkInput): Promise<ShortLink> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const code = LinkRepository.generateCode();
      const existing = await this.namespace.get(this.key(code));
      if (existing !== null) {
        continue;
      }

      const timestamp = new Date().toISOString();
      const link: ShortLink = {
        code,
        destination: input.destination,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.save(link);
      return link;
    }

    throw new Error("Could not allocate a unique short-link code.");
  }

  /**
   * Read one link by code.
   *
   * @param code Validated short code.
   * @returns Stored short link.
   * @throws {ProblemDetailsError} When no link exists for `code`.
   */
  async get(code: string): Promise<ShortLink> {
    return this.parseStoredLink(code, await this.namespace.get(this.key(code)));
  }

  /**
   * List every link using metadata returned by KV's paginated list operation.
   *
   * @returns Short links sorted by most recently changed first.
   */
  async list(): Promise<ShortLink[]> {
    const links: ShortLink[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.namespace.list<LinkMetadata>({
        cursor,
        prefix: LINK_PREFIX,
      });
      for (const key of page.keys) {
        const metadata = key.metadata;
        const code = key.name.slice(LINK_PREFIX.length);
        if (!metadata || !CODE_PATTERN.test(code)) {
          continue;
        }
        links.push({ code, ...metadata });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    return links.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  /**
   * Replace a link destination while preserving its code and creation timestamp.
   *
   * @param code Validated short code.
   * @param input Validated replacement destination.
   * @returns Updated short link.
   * @throws {ProblemDetailsError} When no link exists for `code`.
   */
  async update(code: string, input: LinkInput): Promise<ShortLink> {
    const existing = await this.get(code);
    const link: ShortLink = {
      ...existing,
      destination: input.destination,
      updatedAt: new Date().toISOString(),
    };
    await this.save(link);
    return link;
  }

  /**
   * Remove a link from Workers KV.
   *
   * @param code Validated short code.
   * @returns Promise resolved after the existing link has been deleted.
   * @throws {ProblemDetailsError} When no link exists for `code`.
   */
  async delete(code: string): Promise<void> {
    await this.get(code);
    await this.namespace.delete(this.key(code));
  }
}
