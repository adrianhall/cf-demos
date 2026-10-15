import { describe, expect, it } from 'vitest';
import { DocumentationService } from '../../../src/worker/application/documentation-service';
import type { SourceManifest } from '../../../src/worker/domain/documentation';
import { actorOf } from '../support/actors';
import { MemoryAuditRepository, MemoryDocumentationRepository } from '../support/fake-repositories';

const HASH = 'a'.repeat(64);
const MANIFEST: SourceManifest = {
  repository: 'github.com/cloudflare/cloudflare-docs',
  revision: '7bbbb67b7a',
  entries: [
    {
      path: 'src/content/docs/d1/index.mdx',
      productId: 'd1',
      title: 'Cloudflare D1',
      contentHash: HASH
    }
  ]
};

/**
 * Build the service and expose its dependencies for assertions.
 *
 * @returns The service and in-memory ports it writes through.
 */
function buildService(): {
  service: DocumentationService;
  sources: MemoryDocumentationRepository;
  audit: MemoryAuditRepository;
} {
  const sources = new MemoryDocumentationRepository();
  const audit = new MemoryAuditRepository();
  return { service: new DocumentationService(sources, audit), sources, audit };
}

describe('DocumentationService', () => {
  it('imports only manifest-approved pages and audits the import', async () => {
    const { service, sources, audit } = buildService();
    await expect(
      service.importManifest(
        actorOf('administrator'),
        'correlation',
        MANIFEST,
        new Date('2026-10-15')
      )
    ).resolves.toEqual({ imported: 1, unchanged: 0, revision: '7bbbb67b7a' });
    await expect(sources.find(MANIFEST.entries[0].path)).resolves.toMatchObject({
      contentHash: HASH,
      indexStatus: 'pending'
    });
    expect(audit.events).toMatchObject([{ action: 'documentation.imported' }]);
  });

  it('skips unchanged pages that already indexed successfully', async () => {
    const { service, sources } = buildService();
    const now = new Date('2026-10-15');
    await service.importManifest(actorOf('administrator'), 'first', MANIFEST, now);
    await sources.markIndexed(MANIFEST.entries[0].path, now.toISOString());
    await expect(
      service.importManifest(actorOf('administrator'), 'second', MANIFEST, now)
    ).resolves.toEqual({
      imported: 0,
      unchanged: 1,
      revision: '7bbbb67b7a'
    });
  });

  it('re-imports a changed content hash', async () => {
    const { service, sources } = buildService();
    const now = new Date('2026-10-15');
    await service.importManifest(actorOf('administrator'), 'first', MANIFEST, now);
    await sources.markIndexed(MANIFEST.entries[0].path, now.toISOString());
    const changed = {
      ...MANIFEST,
      revision: 'new-revision',
      entries: [{ ...MANIFEST.entries[0], contentHash: 'b'.repeat(64) }]
    };
    await expect(
      service.importManifest(actorOf('administrator'), 'second', changed, now)
    ).resolves.toMatchObject({
      imported: 1,
      unchanged: 0
    });
  });

  it('does not let a PM import documentation', async () => {
    const { service } = buildService();
    await expect(
      service.importManifest(actorOf('pm'), 'correlation', MANIFEST, new Date())
    ).rejects.toThrow('Only an administrator may manage approved documentation.');
  });

  it('does not let a PM inspect documentation freshness', async () => {
    const { service } = buildService();
    await expect(service.listSources(actorOf('pm'), 20)).rejects.toThrow(
      'Only an administrator may manage approved documentation.'
    );
  });

  it('records a successful documentation index with no person actor', async () => {
    const { service, sources, audit } = buildService();
    await service.importManifest(actorOf('administrator'), 'import', MANIFEST, new Date());
    await service.recordIndexed(MANIFEST.entries[0].path, 'index-run', new Date('2026-10-16'));
    await expect(sources.find(MANIFEST.entries[0].path)).resolves.toMatchObject({
      indexStatus: 'indexed'
    });
    expect(audit.events.at(-1)).toMatchObject({
      action: 'documentation.indexed',
      actorIdentityKey: null,
      resource: `documentation:${MANIFEST.entries[0].path}`
    });
  });
});
