CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES
  ('general', 'system', '2026-07-27T00:00:00.000Z'),
  ('random', 'system', '2026-07-27T00:00:00.000Z');
