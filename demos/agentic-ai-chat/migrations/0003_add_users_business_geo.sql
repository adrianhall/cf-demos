-- Admin cost/metadata console (docs/06-AGENTIC-CHAT.md Section 6.4/6.5, Phase 7, US-6). Both
-- columns are nullable -- an admin has not yet segmented a freshly signed-in user -- and
-- deliberately carry no D1 CHECK constraint: their enum is an application-level concern
-- (`../src/worker/users/business.ts`'s `isBusiness()`/`isGeo()`), so a future added value needs
-- only a code change, never a migration (Phase 7 task 1).
ALTER TABLE users ADD COLUMN business TEXT;
ALTER TABLE users ADD COLUMN geo TEXT;
