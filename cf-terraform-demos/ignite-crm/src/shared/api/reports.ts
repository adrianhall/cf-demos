/**
 * @file Business-health report wire schemas: the filtered pipeline report and the delivery report
 *   (introduction §3.5). Both are aggregate-only: they return counts and totals, never record
 *   content, and every filter is bounded so one request is a small, indexed query. The unfiltered
 *   dashboard pipeline panel keeps using `PipelineSummarySchema` (`./sales.ts`); the Reports page
 *   uses these richer, filterable shapes.
 */

import * as v from 'valibot';
import { DateOnlySchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { UserRefSchema } from './crm.ts';
import { ProjectRefSchema, TaskCountsSchema } from './projects.ts';
import { DealSchema, PipelineSummarySchema, StageSchema } from './sales.ts';

/**
 * The longest closed-date window a pipeline report may cover, in days. Bounded so the won/lost
 * totals stay a small range scan, and generous enough for a year-on-year view.
 */
export const MAX_REPORT_RANGE_DAYS = 366;

/**
 * The most projects a delivery report lists individually. Totals always cover every matching
 * project; only the per-project rows are capped.
 */
export const DELIVERY_REPORT_PROJECT_LIMIT = 50;

/**
 * Whole days between two calendar dates.
 *
 * @param from Earlier `YYYY-MM-DD` date.
 * @param to Later `YYYY-MM-DD` date.
 * @returns `to - from` in days.
 */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * Filters for the pipeline report. Every member is optional; they combine with AND.
 *
 * - `ownerId` narrows open, won, and lost totals to one deal owner.
 * - `closedFrom`/`closedTo` (inclusive calendar dates in the installation's time zone) narrow the won
 *   and lost totals to deals closed in that window. Open deals have no close date, so the by-stage
 *   figures ignore the window.
 */
export const PipelineReportFilterSchema = v.pipe(
  v.strictObject({
    /**
     * Only deals owned by this user.
     */
    ownerId: v.optional(IdSchema),
    /**
     * First close date counted for won/lost, inclusive.
     */
    closedFrom: v.optional(DateOnlySchema),
    /**
     * Last close date counted for won/lost, inclusive.
     */
    closedTo: v.optional(DateOnlySchema)
  }),
  v.forward(
    v.check(
      (filter) =>
        filter.closedFrom === undefined
        || filter.closedTo === undefined
        || filter.closedFrom <= filter.closedTo,
      'The end date must not be before the start date.'
    ),
    ['closedTo']
  ),
  v.forward(
    v.check(
      (filter) =>
        filter.closedFrom === undefined
        || filter.closedTo === undefined
        || daysBetween(filter.closedFrom, filter.closedTo) < MAX_REPORT_RANGE_DAYS,
      `Choose a window of at most ${MAX_REPORT_RANGE_DAYS} days.`
    ),
    ['closedTo']
  )
);

/**
 * Validated pipeline report filters.
 */
export type PipelineReportFilter = v.InferOutput<typeof PipelineReportFilterSchema>;

/**
 * The pipeline report: the summary shape plus the filters that produced it.
 */
export const PipelineReportSchema = v.strictObject({
  ...PipelineSummarySchema.entries,
  /**
   * The filters applied, echoed back with the owner resolved to a display name.
   */
  filter: v.strictObject({
    /**
     * The owner filter, or `null` for everyone.
     */
    owner: v.nullable(UserRefSchema),
    /**
     * First close date counted, or `null` for unbounded.
     */
    closedFrom: v.nullable(DateOnlySchema),
    /**
     * Last close date counted, or `null` for unbounded.
     */
    closedTo: v.nullable(DateOnlySchema)
  })
});

/**
 * A pipeline report.
 */
export type PipelineReport = v.InferOutput<typeof PipelineReportSchema>;

/**
 * Most deals the quarterly pipeline report lists; stage totals always cover every matching deal.
 */
export const QUARTERLY_REPORT_DEAL_LIMIT = 100;

/**
 * A calendar quarter as `YYYY-Qn`, for example `2026-Q4`.
 */
export const QuarterSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-Q[1-4]$/u, 'Choose a quarter such as 2026-Q4.')
);

/**
 * Filters for the quarterly pipeline report.
 */
export const QuarterlyPipelineFilterSchema = v.strictObject({
  /**
   * The quarter; defaults to the current quarter in the installation's time zone.
   */
  quarter: v.optional(QuarterSchema),
  /**
   * Restrict to one owner.
   */
  ownerId: v.optional(IdSchema)
});

/**
 * Validated quarterly pipeline filters.
 */
export type QuarterlyPipelineFilter = v.InferOutput<typeof QuarterlyPipelineFilterSchema>;

/**
 * Open deals expected to close in one calendar quarter, by stage, with the deals themselves.
 */
export const QuarterlyPipelineReportSchema = v.strictObject({
  /**
   * The quarter covered.
   */
  quarter: v.strictObject({
    /**
     * `YYYY-Qn`.
     */
    id: QuarterSchema,
    /**
     * Display label, for example `Q4 2026`.
     */
    label: v.string(),
    /**
     * First day.
     */
    from: DateOnlySchema,
    /**
     * Last day (inclusive).
     */
    to: DateOnlySchema
  }),
  /**
   * Installation currency of every amount.
   */
  currency: v.pipe(v.string(), v.length(3)),
  /**
   * Every stage in pipeline order, including empty ones.
   */
  stages: v.array(
    v.strictObject({
      stage: StageSchema,
      count: v.pipe(v.number(), v.integer(), v.minValue(0)),
      amountMinor: v.pipe(v.number(), v.integer(), v.minValue(0))
    })
  ),
  /**
   * All matching deals.
   */
  total: v.strictObject({
    count: v.pipe(v.number(), v.integer(), v.minValue(0)),
    amountMinor: v.pipe(v.number(), v.integer(), v.minValue(0))
  }),
  /**
   * Matching deals by expected close date, then title (at most
   * {@link QUARTERLY_REPORT_DEAL_LIMIT}).
   */
  deals: v.array(DealSchema),
  /**
   * Whether more deals matched than are listed.
   */
  truncated: v.boolean(),
  /**
   * The owner filter, resolved, or `null` for everyone.
   */
  owner: v.nullable(UserRefSchema)
});

/**
 * A quarterly pipeline report.
 */
export type QuarterlyPipelineReport = v.InferOutput<typeof QuarterlyPipelineReportSchema>;

/**
 * Project states a delivery report can cover. Archived projects are history, not delivery health,
 * so they are not offered.
 */
export const DELIVERY_REPORT_STATUSES = ['active', 'on_hold', 'completed'] as const;

/**
 * Filters for the delivery report.
 */
export const DeliveryReportFilterSchema = v.strictObject({
  /**
   * Project state to cover; defaults to `active`.
   */
  projectStatus: v.optional(
    v.picklist(DELIVERY_REPORT_STATUSES, 'Choose active, on hold, or completed.'),
    'active'
  ),
  /**
   * Only projects led by this user.
   */
  leadId: v.optional(IdSchema)
});

/**
 * Delivery report filters as a caller supplies them (`projectStatus` defaults to `active`).
 */
export type DeliveryReportFilter = v.InferInput<typeof DeliveryReportFilterSchema>;

/**
 * One project's row in the delivery report.
 */
export const DeliveryProjectRowSchema = v.strictObject({
  /**
   * The project.
   */
  project: ProjectRefSchema,
  /**
   * Its lead.
   */
  lead: UserRefSchema,
  /**
   * Target completion date, if set.
   */
  targetDate: v.nullable(DateOnlySchema),
  /**
   * Task counts by status.
   */
  taskCounts: TaskCountsSchema,
  /**
   * Unfinished tasks whose due date is before today.
   */
  overdue: v.pipe(v.number(), v.integer(), v.minValue(0))
});

/**
 * The delivery report: task counts by status across the matching projects.
 */
export const DeliveryReportSchema = v.strictObject({
  /**
   * Today in the installation's time zone (the "overdue" boundary).
   */
  today: DateOnlySchema,
  /**
   * The filters applied, with the lead resolved to a display name.
   */
  filter: v.strictObject({
    /**
     * Project state covered.
     */
    projectStatus: v.picklist(DELIVERY_REPORT_STATUSES),
    /**
     * The lead filter, or `null` for everyone.
     */
    lead: v.nullable(UserRefSchema)
  }),
  /**
   * Number of matching projects.
   */
  projectCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Task counts by status across every matching project.
   */
  taskCounts: TaskCountsSchema,
  /**
   * Overdue unfinished tasks across every matching project.
   */
  overdue: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Per-project rows, most open work first, at most {@link DELIVERY_REPORT_PROJECT_LIMIT}.
   */
  projects: v.array(DeliveryProjectRowSchema),
  /**
   * Whether more projects matched than are listed.
   */
  truncated: v.boolean()
});

/**
 * A delivery report.
 */
export type DeliveryReport = v.InferOutput<typeof DeliveryReportSchema>;
