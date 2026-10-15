-- Phase 4 — escalation queue and PM actions.
--
-- Assignment history is append-only. It makes routing explainable and lets the application reject
-- direct and multi-hop reassignment cycles even when the currently assigned person has changed.

PRAGMA foreign_keys = ON;

CREATE INDEX idx_escalations_queue ON escalations (status, product_id, opened_at);
CREATE INDEX idx_escalation_assignments_escalation ON escalation_assignments (escalation_id, created_at);
