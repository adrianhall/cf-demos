import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { LinkInput, LinkMetadata, LinkRepository, ShortLink } from '../domain/link';
import { CODE_PATTERN } from '../domain/link-validation';

const CODE_LENGTH_BYTES = 9;
const LINK_PREFIX = 'link:';
const MAX_CREATE_ATTEMPTS = 5;

/**
 * Workers KV implementation of the {@link LinkRepository} port. It owns everything storage-specific
 * — the `link:` key namespace, JSON serialization, the metadata copy that makes
 * {@link KvLinkRepository.list} cheap, and generated-code collision retries — so the application
 * layer above it only ever deals in {@link ShortLink} values.
 *
 * Workers KV is eventually consistent and offers no compare-and-set, so `create` cannot guarantee
 * code uniqueness by transaction. The 72-bit code space plus the collision retry below makes an
 * accidental clash vanishingly unlikely, which is the right trade for a redirect store; an
 * invariant that must never be violated belongs in D1 or a Durable Object.
 */
export class KvLinkRepository implements LinkRepository {
  /**
   * @param namespace Workers KV namespace bound to this Worker (`env.LINKS`).
   */
  constructor(private readonly namespace: KVNamespace) {}

  /**
   * Build the namespaced KV key for a short code.
   *
   * @param code Valid short code to scope within this repository's KV prefix.
   * @returns KV key in the `link:<code>` namespace.
   */
  private key(code: string): string {
    return `${LINK_PREFIX}${code}`;
  }

  /**
   * Encode cryptographically secure bytes as an unpadded URL-safe token.
   *
   * @returns A 12-character Base64URL short code derived from 72 random bits.
   */
  private static generateCode(): string {
    const bytes = new Uint8Array(CODE_LENGTH_BYTES);
    crypto.getRandomValues(bytes);
    let value = '';
    for (const byte of bytes) {
      value += String.fromCharCode(byte);
    }
    return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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
      throw notFound({ detail: 'Short link not found.' });
    }

    try {
      const parsed = JSON.parse(value) as Partial<ShortLink>;
      if (
        parsed.code !== code
        || typeof parsed.destination !== 'string'
        || typeof parsed.createdAt !== 'string'
        || typeof parsed.updatedAt !== 'string'
      ) {
        throw new Error('Stored link shape is invalid.');
      }
      return parsed as ShortLink;
    } catch {
      throw notFound({ detail: 'Short link not found.' });
    }
  }

  /**
   * Persist a short-link record with listable metadata.
   *
   * @param link Link to persist.
   * @returns A promise fulfilled after KV accepts the value and listable metadata.
   * @throws {Error} When the KV binding rejects the write.
   */
  private async save(link: ShortLink): Promise<void> {
    const metadata: LinkMetadata = {
      destination: link.destination,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    };
    await this.namespace.put(this.key(link.code), JSON.stringify(link), {
      metadata
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
      const code = KvLinkRepository.generateCode();
      const existing = await this.namespace.get(this.key(code));
      if (existing !== null) {
        continue;
      }

      const timestamp = new Date().toISOString();
      const link: ShortLink = {
        code,
        destination: input.destination,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await this.save(link);
      return link;
    }

    throw new Error('Could not allocate a unique short-link code.');
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
   * @throws {Error} When the KV binding rejects a list request.
   */
  async list(): Promise<ShortLink[]> {
    const links: ShortLink[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.namespace.list<LinkMetadata>({
        cursor,
        prefix: LINK_PREFIX
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

    return links.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Replace a link destination while preserving its code and creation timestamp.
   *
   * @param code Validated short code.
   * @param input Validated replacement destination.
   * @returns Updated short link.
   * @throws {ProblemDetailsError} When no link exists for `code`.
   * @throws {Error} When the KV binding rejects the read or write.
   */
  async update(code: string, input: LinkInput): Promise<ShortLink> {
    const existing = await this.get(code);
    const link: ShortLink = {
      ...existing,
      destination: input.destination,
      updatedAt: new Date().toISOString()
    };
    await this.save(link);
    return link;
  }

  /**
   * Remove a link from Workers KV.
   *
   * @param code Validated short code.
   * @throws {ProblemDetailsError} When no link exists for `code`.
   */
  async delete(code: string): Promise<void> {
    await this.get(code);
    await this.namespace.delete(this.key(code));
  }
}
