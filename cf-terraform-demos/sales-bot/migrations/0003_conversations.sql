-- Phase 3 — shared answer workflow and web chat.
--
-- Phase 1 created the conversation, event, and escalation skeleton. This migration completes the
-- columns the answer workflow actually writes, and adds the uniqueness that makes a retried
-- submission produce one turn rather than two.
--
-- D1 stays authoritative for every turn. The `ConversationSession` Durable Object coordinates
-- ordering and live delivery, but it is not a second source of truth: a reconnecting browser is
-- replayed from these tables, so a turn that is not here never happened.

PRAGMA foreign_keys = ON;

-- What a turn is, which decides how the browser renders it and whether it carries citations.
--
-- A closed list rather than free text, for the same reason `audit_events.action` is one: a
-- transcript view that has to cope with arbitrary kinds cannot offer a reliable filter, and a typo
-- would silently create a category nobody renders.
ALTER TABLE conversation_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'question'
  CHECK (kind IN ('question', 'answer', 'escalation_ack', 'rejection'));

-- Position of the turn within its conversation, assigned by the Durable Object that owns ordering.
--
-- Stored rather than derived from `created_at`, because two turns can share a millisecond and a
-- transcript whose order depends on a timestamp tie is a transcript that reorders itself between
-- reads. The sequence is what a reconnecting client replays by.
ALTER TABLE conversation_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

-- The turn's bounded text.
--
-- `content_reference` (Phase 1) names *where* the content lives and `content_hash` proves what it
-- was; this column is the content itself for the `web` channel, which has no external store to
-- reference. Keeping all three is what lets a post-MVP channel keep its body outside D1 without the
-- transcript reader needing to know which channel it is reading.
--
-- Bounded by the application (`src/worker/domain/conversation-validation.ts`) rather than by the
-- column, because SQLite cannot express a character bound and a silently truncated answer would be
-- worse than a rejected one. Retention is configurable in Phase 5.
ALTER TABLE conversation_events ADD COLUMN content_text TEXT;

-- Citations backing an answer, as a JSON array of `{ sourceType, reference, title }`.
--
-- Stored with the turn rather than resolved at read time: the FAQ revision or documentation page an
-- answer quoted is a fact about *that answer*, and re-resolving it later would show a reader
-- citations for content that has since changed. The audience filter is applied again before
-- delivery regardless, so a stored citation can never widen what a reader sees.
ALTER TABLE conversation_events ADD COLUMN citations TEXT;

-- Which reviewed model produced an answer, and the AI Gateway log it was recorded under.
--
-- Both are identifiers, not content. They are what makes a specific answer traceable in the gateway
-- dashboard without retaining the prompt or the generated text anywhere outside this table.
ALTER TABLE conversation_events ADD COLUMN model_id TEXT;
ALTER TABLE conversation_events ADD COLUMN gateway_log_id TEXT;

-- Client-supplied idempotency key for a submitted question.
--
-- Nullable because only a question carries one: an answer is produced by the application, which has
-- no retry to deduplicate. The uniqueness index below is scoped to the conversation so two
-- conversations may reuse a key, which a client that derives keys per conversation will do.
ALTER TABLE conversation_events ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_conversation_events_idempotency
  ON conversation_events (conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Replay order for a reconnecting browser, and the lookup the Durable Object uses to find the next
-- sequence number. One index serves both because both read `(conversation_id, sequence)`.
CREATE UNIQUE INDEX idx_conversation_events_sequence
  ON conversation_events (conversation_id, sequence);

CREATE INDEX idx_conversations_requester ON conversations (requester_identity_key, updated_at DESC);

-- Why an escalation was opened, as a reason code rather than the question text.
--
-- The three codes the answer workflow can produce are `requested` (the salesperson asked),
-- `insufficient_evidence` (the decision model found nothing to ground an answer in), and
-- `restricted_evidence` (the only matching knowledge was outside the requester's clearance). The
-- third is deliberately distinguishable: it is the case where a PM must answer *because* the
-- requester may not see the source, and an operator reviewing the queue needs to know that.
ALTER TABLE escalations ADD COLUMN reason TEXT;
