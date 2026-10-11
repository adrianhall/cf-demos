/**
 * @file Sales workflow wire schemas: pipeline, deals, activities (calls and meetings), contact next
 *   actions, the action stream, and the pipeline summary. As with `crm.ts`, the same values cross
 *   the Data Worker RPC boundary unchanged. Request schemas are `strictObject`s, so an attempt to
 *   smuggle an `authorId`, `closedAt`, or `version` into a body is rejected rather than ignored.
 *   Money is always integer minor units (pence) in the installation currency. Calendar dates with
 *   no time — next-action and expected-close dates — are `YYYY-MM-DD`; instants are UTC ISO.
 */

import * as v from 'valibot';
import { DateOnlySchema, TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import {
  OptionalDateSchema,
  optionalText,
  requiredText,
  SearchTermSchema
} from '../validation/fields.ts';
import { HistoryEntrySchema, UserRefSchema } from './crm.ts';

/**
 * The fixed deal outcomes the system reasons about (reporting, conversion).
 */
export const DEAL_STATUSES = ['pending', 'won', 'lost'] as const;

/**
 * Schema for a deal status.
 */
export const DealStatusSchema = v.picklist(DEAL_STATUSES, 'Status must be pending, won, or lost.');

/**
 * A deal status.
 */
export type DealStatus = v.InferOutput<typeof DealStatusSchema>;

/**
 * Interaction types an activity can record.
 */
export const ACTIVITY_TYPES = ['call', 'meeting'] as const;

/**
 * Schema for an activity type.
 */
export const ActivityTypeSchema = v.picklist(ACTIVITY_TYPES, 'Type must be call or meeting.');

/**
 * Largest amount accepted, in minor units (£10bn): far beyond a small business deal, and well
 * inside JavaScript's exact-integer range.
 */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/**
 * Schema for an amount in minor units.
 */
export const AmountMinorSchema = v.pipe(
  v.number('Amount must be a number.'),
  v.integer('Amount must be a whole number of pence.'),
  v.minValue(0, 'Amount cannot be negative.'),
  v.maxValue(MAX_AMOUNT_MINOR, 'Amount is too large.')
);

/**
 * Most contacts one activity may link.
 */
export const MAX_ACTIVITY_CONTACTS = 20;

/**
 * A reference to a contact.
 */
export const ContactRefSchema = v.strictObject({
  /**
   * Contact identifier.
   */
  id: IdSchema,
  /**
   * Display name.
   */
  displayName: v.string()
});

/**
 * A reference to a company.
 */
export const CompanyRefSchema = v.strictObject({
  /**
   * Company identifier.
   */
  id: IdSchema,
  /**
   * Company name.
   */
  name: v.string()
});

/**
 * A reference to a deal.
 */
export const DealRefSchema = v.strictObject({
  /**
   * Deal identifier.
   */
  id: IdSchema,
  /**
   * Deal title.
   */
  title: v.string()
});

/**
 * One pipeline stage.
 */
export const StageSchema = v.strictObject({
  /**
   * Stage identifier.
   */
  id: IdSchema,
  /**
   * Stable machine key, e.g. `proposal`.
   */
  key: v.string(),
  /**
   * Display label.
   */
  label: v.string(),
  /**
   * 1-based order within the pipeline.
   */
  position: v.pipe(v.number(), v.integer(), v.minValue(1))
});

/**
 * A pipeline stage.
 */
export type Stage = v.InferOutput<typeof StageSchema>;

/**
 * The sales pipeline and its ordered stages.
 */
export const PipelineSchema = v.strictObject({
  /**
   * Pipeline identifier.
   */
  id: IdSchema,
  /**
   * Pipeline name.
   */
  name: v.string(),
  /**
   * Stages in position order.
   */
  stages: v.array(StageSchema)
});

/**
 * A pipeline.
 */
export type Pipeline = v.InferOutput<typeof PipelineSchema>;

/**
 * A deal.
 */
export const DealSchema = v.strictObject({
  /**
   * Deal identifier.
   */
  id: IdSchema,
  /**
   * Deal title.
   */
  title: v.string(),
  /**
   * Fixed outcome.
   */
  status: DealStatusSchema,
  /**
   * Current pipeline stage (kept when the deal closes).
   */
  stage: StageSchema,
  /**
   * The deal's pipeline.
   */
  pipeline: v.strictObject({ id: IdSchema, name: v.string() }),
  /**
   * Customer company, if any.
   */
  company: v.nullable(CompanyRefSchema),
  /**
   * The person this deal is sold to; independent of the company's primary contact.
   */
  primaryContact: ContactRefSchema,
  /**
   * Responsible user.
   */
  owner: UserRefSchema,
  /**
   * Free-text status line for humans; never parsed.
   */
  statusLine: v.nullable(v.string()),
  /**
   * Next action description; set together with {@link nextActionDate}, only while pending.
   */
  nextActionText: v.nullable(v.string()),
  /**
   * Next action date.
   */
  nextActionDate: v.nullable(DateOnlySchema),
  /**
   * Value in minor units.
   */
  amountMinor: AmountMinorSchema,
  /**
   * ISO 4217 currency of {@link amountMinor}.
   */
  currency: v.pipe(v.string(), v.length(3)),
  /**
   * Expected close date, if estimated.
   */
  expectedCloseDate: v.nullable(DateOnlySchema),
  /**
   * When the deal was won or lost; `null` while pending.
   */
  closedAt: v.nullable(TimestampSchema),
  /**
   * The delivery project this won deal was converted into, once converted (Phase 3). Declared
   * inline rather than importing `projects.ts`, which itself depends on this module.
   */
  project: v.nullable(v.strictObject({ id: IdSchema, name: v.string() })),
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A deal.
 */
export type Deal = v.InferOutput<typeof DealSchema>;

/**
 * One page of deals.
 */
export const DealPageSchema = pageSchema(DealSchema);

/**
 * A call or meeting.
 */
export const ActivitySchema = v.strictObject({
  /**
   * Activity identifier.
   */
  id: IdSchema,
  /**
   * Interaction type.
   */
  type: ActivityTypeSchema,
  /**
   * Short subject.
   */
  subject: v.string(),
  /**
   * Optional summary of what was said.
   */
  summary: v.nullable(v.string()),
  /**
   * When the interaction happened.
   */
  occurredAt: TimestampSchema,
  /**
   * Duration in minutes, if recorded.
   */
  durationMinutes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /**
   * Who logged it.
   */
  author: UserRefSchema,
  /**
   * Every linked contact, by name. A contact deleted later remains as a tombstone (`deleted`).
   */
  contacts: v.array(
    v.strictObject({ id: IdSchema, displayName: v.string(), deleted: v.boolean() })
  ),
  /**
   * Linked company, if any.
   */
  company: v.nullable(CompanyRefSchema),
  /**
   * Linked deal, if any.
   */
  deal: v.nullable(DealRefSchema),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema
});

/**
 * An activity.
 */
export type Activity = v.InferOutput<typeof ActivitySchema>;

/**
 * A contact's one open next action.
 */
export const ContactNextActionSchema = v.strictObject({
  /**
   * Follow-up identifier.
   */
  id: IdSchema,
  /**
   * What to do.
   */
  text: v.string(),
  /**
   * When; `null` means as soon as possible.
   */
  dueDate: v.nullable(DateOnlySchema),
  /**
   * Who it is assigned to (the user who set it).
   */
  assignee: UserRefSchema,
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A contact next action.
 */
export type ContactNextAction = v.InferOutput<typeof ContactNextActionSchema>;

/**
 * A deal with its interactions and history.
 */
export const DealDetailSchema = v.strictObject({
  /**
   * The deal.
   */
  deal: DealSchema,
  /**
   * Activities linked to the deal, newest first (at most 50).
   */
  activities: v.array(ActivitySchema),
  /**
   * Most recent history entries, newest first.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A deal detail projection.
 */
export type DealDetail = v.InferOutput<typeof DealDetailSchema>;

/**
 * Request body for creating a deal.
 *
 * Omitting `companyId` files the deal under the primary contact's company; `null` records a deal
 * with no company. Omitting `stageId` starts at the pipeline's first stage, and omitting `ownerId`
 * makes the caller the owner. A next action needs both its text and its date.
 */
export const CreateDealInputSchema = v.pipe(
  v.strictObject({
    /**
     * Deal title.
     */
    title: requiredText('Title', 200),
    /**
     * Primary contact.
     */
    primaryContactId: IdSchema,
    /**
     * Customer company; see the schema description for the omitted case.
     */
    companyId: v.optional(v.nullable(IdSchema)),
    /**
     * Starting stage.
     */
    stageId: v.optional(IdSchema),
    /**
     * Value in minor units.
     */
    amountMinor: v.optional(AmountMinorSchema, 0),
    /**
     * Free-text status line.
     */
    statusLine: optionalText('Status line', 160),
    /**
     * Next action description.
     */
    nextActionText: optionalText('Next action', 140),
    /**
     * Next action date.
     */
    nextActionDate: OptionalDateSchema,
    /**
     * Expected close date.
     */
    expectedCloseDate: OptionalDateSchema,
    /**
     * Owner; assigning a deal to someone else needs `crm.assign`.
     */
    ownerId: v.optional(IdSchema)
  }),
  v.forward(
    v.check(
      (input) => (input.nextActionText === null) === (input.nextActionDate === null),
      'A next action needs both a description and a date.'
    ),
    ['nextActionDate']
  )
);

/**
 * A validated create-deal request.
 */
export type CreateDealInput = v.InferOutput<typeof CreateDealInputSchema>;

/**
 * Request body for updating a deal. Omitted fields are unchanged; `null` clears a field. Whether
 * the resulting deal is consistent (for example, a next action on a won deal) is a domain rule
 * checked against the merged state, not here.
 */
export const UpdateDealInputSchema = v.pipe(
  v.strictObject({
    /**
     * New title.
     */
    title: v.optional(requiredText('Title', 200)),
    /**
     * New primary contact.
     */
    primaryContactId: v.optional(IdSchema),
    /**
     * New company, or `null` for none.
     */
    companyId: v.optional(v.nullable(IdSchema)),
    /**
     * New stage.
     */
    stageId: v.optional(IdSchema),
    /**
     * New outcome. Winning or losing clears the next action and stamps the close time.
     */
    status: v.optional(DealStatusSchema),
    /**
     * New status line.
     */
    statusLine: v.optional(optionalText('Status line', 160)),
    /**
     * New next action description.
     */
    nextActionText: v.optional(optionalText('Next action', 140)),
    /**
     * New next action date.
     */
    nextActionDate: v.optional(OptionalDateSchema),
    /**
     * New amount.
     */
    amountMinor: v.optional(AmountMinorSchema),
    /**
     * New expected close date.
     */
    expectedCloseDate: v.optional(OptionalDateSchema),
    /**
     * Explicit owner assignment; needs `crm.assign` even when the id is unchanged.
     */
    ownerId: v.optional(IdSchema)
  }),
  v.check((input) => Object.keys(input).length > 0, 'Provide at least one field to change.')
);

/**
 * A validated update-deal request.
 */
export type UpdateDealInput = v.InferOutput<typeof UpdateDealInputSchema>;

/**
 * Request body for logging a call or meeting.
 */
export const CreateActivityInputSchema = v.strictObject({
  /**
   * Interaction type.
   */
  type: ActivityTypeSchema,
  /**
   * Subject.
   */
  subject: requiredText('Subject', 200),
  /**
   * Summary.
   */
  summary: optionalText('Summary', 4000),
  /**
   * When it happened; must not be in the future.
   */
  occurredAt: TimestampSchema,
  /**
   * Duration in minutes.
   */
  durationMinutes: v.optional(
    v.nullable(
      v.pipe(
        v.number('Duration must be a number.'),
        v.integer('Duration must be whole minutes.'),
        v.minValue(1, 'Duration must be at least 1 minute.'),
        v.maxValue(1440, 'Duration must be at most 24 hours.')
      )
    ),
    null
  ),
  /**
   * Linked contacts: at least one, no duplicates.
   */
  contactIds: v.pipe(
    v.array(IdSchema),
    v.minLength(1, 'Choose at least one contact.'),
    v.maxLength(MAX_ACTIVITY_CONTACTS, `Choose at most ${MAX_ACTIVITY_CONTACTS} contacts.`),
    v.check((ids) => new Set(ids).size === ids.length, 'Each contact may be linked only once.')
  ),
  /**
   * Linked company.
   */
  companyId: v.optional(v.nullable(IdSchema), null),
  /**
   * Linked deal.
   */
  dealId: v.optional(v.nullable(IdSchema), null)
});

/**
 * A validated create-activity request.
 */
export type CreateActivityInput = v.InferOutput<typeof CreateActivityInputSchema>;

/**
 * Request body for setting (or replacing) a contact's next action.
 */
export const SetNextActionInputSchema = v.strictObject({
  /**
   * What to do.
   */
  text: requiredText('Next action', 140),
  /**
   * When; `null` or omitted means as soon as possible.
   */
  dueDate: OptionalDateSchema
});

/**
 * A validated set-next-action request.
 */
export type SetNextActionInput = v.InferOutput<typeof SetNextActionInputSchema>;

/**
 * How urgent an action is, relative to "today" in the installation time zone.
 */
export const URGENCIES = ['asap', 'overdue', 'today', 'upcoming'] as const;

/**
 * An urgency.
 */
export type Urgency = (typeof URGENCIES)[number];

/**
 * One row in the action stream.
 */
export const ActionItemSchema = v.strictObject({
  /**
   * Where it came from: a contact's next action or a deal's.
   */
  kind: v.picklist(['contact', 'deal']),
  /**
   * Follow-up id (`contact`) or deal id (`deal`).
   */
  id: IdSchema,
  /**
   * What to do.
   */
  text: v.string(),
  /**
   * When; `null` for an ASAP contact action.
   */
  dueDate: v.nullable(DateOnlySchema),
  /**
   * Urgency relative to the stream's `today`.
   */
  urgency: v.picklist(URGENCIES),
  /**
   * The contact to chase (a deal's primary contact for `deal` rows).
   */
  contact: ContactRefSchema,
  /**
   * The deal, for `deal` rows.
   */
  deal: v.nullable(DealRefSchema),
  /**
   * The contact's or deal's company, if any.
   */
  company: v.nullable(CompanyRefSchema)
});

/**
 * An action stream row.
 */
export type ActionItem = v.InferOutput<typeof ActionItemSchema>;

/**
 * The signed-in user's prioritized follow-ups.
 */
export const ActionStreamSchema = v.strictObject({
  /**
   * The calendar date urgencies were computed against (installation time zone).
   */
  today: DateOnlySchema,
  /**
   * Rows in priority order: ASAP, overdue, today, upcoming (at most 100).
   */
  items: v.array(ActionItemSchema)
});

/**
 * The action stream.
 */
export type ActionStream = v.InferOutput<typeof ActionStreamSchema>;

/**
 * A count with its total value.
 */
const TotalSchema = v.strictObject({
  /**
   * Number of deals.
   */
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Their summed value in minor units.
   */
  amountMinor: v.pipe(v.number(), v.integer(), v.minValue(0))
});

/**
 * Pipeline totals for the pipeline summary report.
 */
export const PipelineSummarySchema = v.strictObject({
  /**
   * The pipeline.
   */
  pipeline: v.strictObject({ id: IdSchema, name: v.string() }),
  /**
   * Installation currency of every amount.
   */
  currency: v.pipe(v.string(), v.length(3)),
  /**
   * Open (pending) deals by stage, in stage order, including empty stages.
   */
  stages: v.array(v.strictObject({ stage: StageSchema, ...TotalSchema.entries })),
  /**
   * All open deals.
   */
  open: TotalSchema,
  /**
   * Won deals.
   */
  won: TotalSchema,
  /**
   * Lost deals.
   */
  lost: TotalSchema,
  /**
   * Open deals expected to close in the current calendar quarter (installation time zone).
   */
  thisQuarter: v.strictObject({
    /**
     * The quarter, for example `Q4 2026`.
     */
    label: v.string(),
    /**
     * First day of the quarter.
     */
    from: DateOnlySchema,
    /**
     * Last day of the quarter (inclusive).
     */
    to: DateOnlySchema,
    ...TotalSchema.entries
  })
});

/**
 * A pipeline summary.
 */
export type PipelineSummary = v.InferOutput<typeof PipelineSummarySchema>;

/**
 * Query string for listing or searching deals.
 */
export const DealListQuerySchema = v.strictObject({
  /**
   * Search term matched against title, company, and primary contact.
   */
  q: v.optional(SearchTermSchema),
  /**
   * Restrict to one outcome.
   */
  status: v.optional(DealStatusSchema),
  /**
   * Restrict to one pipeline stage.
   */
  stage: v.optional(IdSchema),
  /**
   * Page size, 1–100.
   */
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,3}$/u, 'limit must be a whole number.'),
      v.transform(Number),
      v.minValue(1, 'limit must be at least 1.'),
      v.maxValue(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}.`)
    )
  ),
  /**
   * Cursor from the previous page.
   */
  cursor: v.optional(CursorSchema)
});
