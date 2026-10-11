-- Ignite CRM — Deals list stage filter.
--
-- The Deals table view can filter by pipeline stage. The list's keyset order is
-- (lower(title), id); this index serves "deals in one stage" in that same order, so a filtered
-- page is an index range scan rather than a scan of every deal. `deals_pipeline` (pipeline, stage,
-- status) is unchanged and still serves the pipeline summary.
CREATE INDEX deals_stage_list ON deals (stage_id, lower(title), id) WHERE deleted_at IS NULL;
