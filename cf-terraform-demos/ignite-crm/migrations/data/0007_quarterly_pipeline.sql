-- Ignite CRM — quarterly pipeline report.
--
-- "Open deals expected to close this quarter" ranges over expected_close_date. This partial index
-- covers exactly those rows (open, dated, live) in the report's listing order, so the dashboard
-- line and the quarterly report are index range scans however many closed deals accumulate.
CREATE INDEX deals_expected_close
  ON deals (pipeline_id, expected_close_date, lower(title), id)
  WHERE deleted_at IS NULL AND status = 'pending' AND expected_close_date IS NOT NULL;
