-- The channel *directory* and nothing else. Every column here answers "which channels exist and
-- where did they come from"; no column holds a message. Messages live in each channel's own
-- Durable Object storage (see src/worker/infrastructure/chat-room.ts), because an ordered stream
-- with live fan-out to connected readers is a coordination problem rather than a query problem.
CREATE TABLE IF NOT EXISTS channels (
  -- The name is the primary key rather than a surrogate id, and that is deliberate. It is also
  -- the Durable Object's name, so making it the key means the directory row and the room it
  -- refers to are linked by one value that cannot disagree with itself — there is no room
  -- identifier to store, and therefore no way for a row to point at the wrong room. The key also
  -- supplies the uniqueness guarantee the repository relies on to resolve a race between two
  -- participants creating the same channel at the same moment.
  name TEXT PRIMARY KEY,
  -- Verified Cloudflare Access identity (the JWT `email` claim) that created the channel. Never
  -- supplied by the client; see src/worker/routes/identity.ts.
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Two channels so a fresh install has something to demonstrate immediately: switching between
-- them shows that each name addresses a separate Durable Object with its own, completely
-- independent history. `system` is a deliberately non-routable author — no Access identity can
-- ever equal it — which makes seeded rows visually distinct from participant-created ones.
--
-- `INSERT OR IGNORE` keeps the migration idempotent: re-running it against a database where a
-- participant has since removed `general` will not resurrect it, and re-running it against an
-- untouched database changes nothing.
INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES
  ('general', 'system', '2026-01-01T00:00:00.000Z'),
  ('random', 'system', '2026-01-01T00:00:00.000Z');
