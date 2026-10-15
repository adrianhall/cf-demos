-- Phase 2 — FAQ and documentation knowledge base.
--
-- Phase 1 created the whole data-model skeleton. This migration completes the three tables the
-- knowledge base actually writes to, and seeds the supplied product-ownership map.
--
-- Ownership names are display names, not credentials. The seed CSV in the product introduction
-- lists people, and a deployment maps those people to verified Cloudflare Access identities with
-- `product_scopes` during setup. Storing them as free text here keeps the seed truthful: it records
-- who owns a product, and deliberately grants nobody any authority until an administrator maps an
-- identity.

PRAGMA foreign_keys = ON;

-- Default escalation target per product. Separate from `primary_pm` because the escalation ladder
-- and day-to-day ownership differ for several products (AI Gateway and AI Search escalate to the
-- Workers AI PM rather than to the catch-all).
ALTER TABLE products ADD COLUMN escalation_target TEXT;

-- Audience clearance of a verified identity, which caps the FAQ audiences it may read. NULL means
-- "derive it from the role", which is the fail-closed default applied by the application
-- (`src/worker/domain/audience.ts`). An administrator raises an individual's clearance by setting
-- this column; nothing in a request can change it.
ALTER TABLE identities ADD COLUMN audience_clearance TEXT
  CHECK (audience_clearance IN ('public', 'customer', 'nda', 'internal'));

-- Whether the index job replaces the document or removes it. An archived or superseded revision
-- needs its search document deleted, and that deletion has to be as retryable as an upload, so it
-- is the same row with a different operation rather than a second mechanism.
ALTER TABLE faq_index_jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'upsert'
  CHECK (operation IN ('upsert', 'delete'));
ALTER TABLE faq_index_jobs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

-- Phase 1 keyed jobs by `(faq_id, faq_revision)`, which prevents a publication job and the later
-- removal job for that *same* revision from coexisting. Both are real, independently retryable
-- operations: otherwise an expiry after the upload completed can never enqueue deletion. Rebuild
-- the table with the operation in the uniqueness key, preserving any Phase 1 rows.
CREATE TABLE faq_index_jobs_next (
  id TEXT PRIMARY KEY,
  faq_id TEXT NOT NULL,
  faq_revision INTEGER NOT NULL,
  search_document_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  updated_at TEXT NOT NULL,
  UNIQUE(faq_id, faq_revision, operation),
  FOREIGN KEY (faq_id, faq_revision) REFERENCES faqs(id, revision)
);
INSERT INTO faq_index_jobs_next (
  id, faq_id, faq_revision, search_document_id, status, attempts, last_error, operation, updated_at
)
SELECT id, faq_id, faq_revision, search_document_id, status, attempts, last_error, operation, updated_at
FROM faq_index_jobs;
DROP TABLE faq_index_jobs;
ALTER TABLE faq_index_jobs_next RENAME TO faq_index_jobs;

CREATE INDEX idx_faqs_product_status ON faqs (product_id, status);
CREATE INDEX idx_faq_index_jobs_status ON faq_index_jobs (status);
CREATE INDEX idx_audit_events_created_at ON audit_events (created_at DESC);

-- Approved documentation pages, imported from the committed manifest. The table is keyed by the
-- manifest path rather than by a surrogate ID so an import is idempotent: re-importing the same
-- manifest updates the row for a page instead of creating a second copy of it.
CREATE TABLE documentation_sources (
  path TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  imported_at TEXT NOT NULL,
  indexed_at TEXT
);
CREATE INDEX idx_documentation_sources_status ON documentation_sources (index_status);

-- Supplied product-ownership map. `OR IGNORE` on a stable slug makes the seed re-runnable, which
-- matters because a later migration may add products to the same table.
INSERT OR IGNORE INTO products (id, name, primary_pm, escalation_target, active) VALUES
  ('basin', 'Basin', 'Mark Selwan', 'Rita Koslov', 1),
  ('stream', 'Stream', 'Taylor Smith', 'Rita Koslov', 1),
  ('images', 'Images', 'Deanna Lam', 'Rita Koslov', 1),
  ('realtime-kit', 'Realtime Kit', 'Korinne Alpers', 'Rita Koslov', 1),
  ('workers-ai', 'Workers AI', 'Michelle Chen', 'Rita Koslov', 1),
  ('ai-gateway', 'AI Gateway', 'Ming Lu', 'Michelle Chen', 1),
  ('ai-search', 'AI Search', 'Anni Wang', 'Michelle Chen', 1),
  ('browser-run', 'Browser Run', 'Kathy Liao', 'Rita Koslov', 1),
  ('agents', 'Agents', 'Thomas Gauvin', 'Rita Koslov', 1),
  ('email', 'Email', 'Thomas Gauvin', 'Rita Koslov', 1),
  ('gadgets', 'Gadgets', 'Phillip Jones', 'Rita Koslov', 1),
  ('durable-objects', 'Durable Objects', 'Brendon Iglesias', 'Brendan Irvine-Broque', 1),
  ('d1', 'D1', 'Ivory Ibuaka', 'Vy Ton', 1),
  ('kv', 'KV', 'Ivory Ibuaka', 'Vy Ton', 1),
  ('hyperdrive', 'Hyperdrive', 'Ivory Ibuaka', 'Vy Ton', 1),
  ('workers-for-platforms', 'Workers for Platforms', 'Dina Koslov', 'Brendan Irvine-Broque', 1);
