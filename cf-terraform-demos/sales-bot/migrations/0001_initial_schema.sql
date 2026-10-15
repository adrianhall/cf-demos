PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  identity_key TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  source_channel TEXT NOT NULL DEFAULT 'web' CHECK (source_channel = 'web'),
  verification_method TEXT NOT NULL DEFAULT 'cloudflare_access',
  role TEXT NOT NULL DEFAULT 'salesperson' CHECK (role IN ('salesperson', 'pm', 'overseer', 'administrator')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, primary_pm TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE product_scopes (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL REFERENCES identities(identity_key), product_id TEXT NOT NULL REFERENCES products(id), role TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK (channel = 'web'), external_thread_key TEXT, requester_identity_key TEXT NOT NULL REFERENCES identities(identity_key), product_id TEXT REFERENCES products(id), status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE conversation_events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), actor_identity_key TEXT REFERENCES identities(identity_key), visibility TEXT NOT NULL, content_reference TEXT NOT NULL, content_hash TEXT NOT NULL, delivery_state TEXT NOT NULL, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE escalations (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), question_event_id TEXT NOT NULL REFERENCES conversation_events(id), product_id TEXT REFERENCES products(id), current_assignee TEXT, status TEXT NOT NULL, opened_at TEXT NOT NULL, answered_at TEXT, closed_at TEXT, UNIQUE(question_event_id));
CREATE TABLE escalation_assignments (id TEXT PRIMARY KEY, escalation_id TEXT NOT NULL REFERENCES escalations(id), actor_identity_key TEXT REFERENCES identities(identity_key), previous_assignee TEXT, current_assignee TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE faqs (id TEXT NOT NULL, revision INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, product_id TEXT REFERENCES products(id), owner_identity_key TEXT REFERENCES identities(identity_key), audience TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL, source_escalation_id TEXT REFERENCES escalations(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id, revision));
CREATE TABLE faq_index_jobs (id TEXT PRIMARY KEY, faq_id TEXT NOT NULL, faq_revision INTEGER NOT NULL, search_document_id TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, UNIQUE(faq_id, faq_revision), FOREIGN KEY (faq_id, faq_revision) REFERENCES faqs(id, revision));
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_identity_key TEXT REFERENCES identities(identity_key), action TEXT NOT NULL, resource TEXT NOT NULL, reason TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL);
