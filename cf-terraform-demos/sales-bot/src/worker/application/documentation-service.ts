import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import { isAdministrator, type Actor } from '../domain/actor';
import type { AuditRepository } from '../domain/audit';
import {
  needsReindex,
  validateDocumentationPath,
  validateSourceManifest,
  type DocumentationRepository,
  type DocumentationSource,
  type ImportedPage,
  type SourceManifest
} from '../domain/documentation';

/**
 * Result of importing one manifest.
 */
export interface ImportSummary {
  /**
   * Pages whose content changed and were queued for indexing.
   */
  imported: number;
  /**
   * Pages already stored with the same content hash and title, left alone.
   */
  unchanged: number;
  /**
   * Source revision the import was performed at.
   */
  revision: string;
}

/**
 * Largest number of pages one import request may process.
 *
 * The committed manifest is a review artefact, so it is small by design. The bound exists so a
 * mistakenly enormous manifest fails fast with a clear message rather than exhausting the Worker's
 * CPU budget halfway through.
 */
export const MAX_MANIFEST_ENTRIES = 500;

/**
 * Import and inspection of approved Cloudflare documentation.
 *
 * Every operation here is administrator-only. Documentation is the ground truth the agent will
 * answer from in Phase 3, so changing which pages are approved is a change to what the product is
 * willing to claim — a PM's product scope does not extend that far.
 */
export class DocumentationService {
  /**
   * @param sources Documentation persistence port.
   * @param audit Audit trail port.
   */
  public constructor(
    private readonly sources: DocumentationRepository,
    private readonly audit: AuditRepository
  ) {}

  /**
   * Import every page a manifest approves.
   *
   * A page whose stored content hash and title are unchanged and whose index status is `indexed` is
   * skipped. Most commits to a documentation repository touch few pages, so re-indexing the whole
   * manifest on every import would make an import cost proportional to the manifest rather than to
   * what actually changed.
   *
   * @param actor Resolved authorization subject.
   * @param correlationId Correlation identifier for this request.
   * @param manifestDocument Unvalidated manifest, parsed from the committed JSON file or supplied
   *   by the request.
   * @param now Instant recorded as the import time.
   * @returns Counts of imported and unchanged pages.
   * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator;
   *   `unprocessableContent()` (422) when the manifest is malformed, approves a page twice, or
   *   exceeds {@link MAX_MANIFEST_ENTRIES}.
   * @throws {Error} When the content port or the repository rejects a read or write.
   */
  public async importManifest(
    actor: Actor,
    correlationId: string,
    manifestDocument: unknown,
    now: Date
  ): Promise<ImportSummary> {
    this.requireAdministrator(actor);
    const manifest = this.validateManifest(manifestDocument);
    const importedAt = now.toISOString();
    const summary: ImportSummary = { imported: 0, unchanged: 0, revision: manifest.revision };

    for (const entry of manifest.entries) {
      const page: ImportedPage = { entry, sourceRevision: manifest.revision };
      if (!needsReindex(await this.sources.find(entry.path), page)) {
        summary.unchanged += 1;
        continue;
      }
      await this.sources.upsert(page, importedAt);
      summary.imported += 1;
    }

    await this.audit.record({
      actorIdentityKey: actor.identityKey,
      action: 'documentation.imported',
      resource: `manifest:${manifest.revision}`,
      reason: `imported=${summary.imported};unchanged=${summary.unchanged}`,
      correlationId
    });
    return summary;
  }

  /**
   * List approved pages and their indexing state.
   *
   * @param actor Resolved authorization subject.
   * @param limit Largest number of pages to return.
   * @returns Approved pages ordered by path.
   * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator.
   * @throws {Error} When the repository rejects the read.
   */
  public async listSources(actor: Actor, limit: number): Promise<DocumentationSource[]> {
    this.requireAdministrator(actor);
    return this.sources.list(limit);
  }

  /**
   * Record that an approved page was successfully indexed.
   *
   * @param path Manifest path, re-validated because it may arrive from a queue message rather than
   *   from a request that already validated it.
   * @param correlationId Correlation identifier for the indexing run.
   * @param now Instant recorded as the index time.
   * @returns A promise fulfilled once the page and audit entry are durable.
   * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the path is not a valid
   *   manifest path.
   * @throws {Error} When the repository rejects the write.
   */
  public async recordIndexed(path: string, correlationId: string, now: Date): Promise<void> {
    const validated = validateDocumentationPath(path);
    await this.sources.markIndexed(validated, now.toISOString());
    await this.audit.record({
      actorIdentityKey: null,
      action: 'documentation.indexed',
      resource: `documentation:${validated}`,
      reason: null,
      correlationId
    });
  }

  /**
   * Validate a manifest and enforce the entry bound.
   *
   * @param manifestDocument Unvalidated manifest.
   * @returns The validated manifest.
   * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the manifest is malformed or
   *   too large.
   */
  private validateManifest(manifestDocument: unknown): SourceManifest {
    const manifest = validateSourceManifest(manifestDocument);
    if (manifest.entries.length > MAX_MANIFEST_ENTRIES) {
      throw forbidden({
        detail: `A manifest may approve at most ${MAX_MANIFEST_ENTRIES} pages.`
      });
    }
    return manifest;
  }

  /**
   * Require that the actor administers the installation.
   *
   * `403` rather than `404` here, unlike the FAQ routes: the administration surface is not a
   * secret, and a PM who reaches it should be told they lack the role rather than be left to
   * conclude the endpoint does not exist.
   *
   * @param actor Resolved authorization subject.
   * @returns Nothing; it either passes or throws.
   * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator.
   */
  private requireAdministrator(actor: Actor): void {
    if (!isAdministrator(actor)) {
      throw forbidden({ detail: 'Only an administrator may manage approved documentation.' });
    }
  }
}
