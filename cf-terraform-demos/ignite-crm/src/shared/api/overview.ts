/**
 * @file Customer overview wire schemas: one composite view of a contact or company that the
 *   Application Worker assembles from parallel, bounded Data Worker reads (specification §8.1).
 *
 *   - The **core** section (the record, its next action, deals, delivery projects, activities, and
 *     history) is one Data Worker read. If it fails, the whole request fails.
 *   - The **notes** section is a separate read. If it fails for a retryable reason, the overview is
 *     still returned with `notes: null` and an explicit entry in `warnings`, so the customer page
 *     stays usable. An authorization failure is never downgraded to a warning: it fails the
 *     request.
 *   - The **timeline** merges activities, deal milestones, projects, and notes newest first, so a
 *     reader sees the customer's story in one list.
 */

import * as v from 'valibot';
import { TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { UserRefSchema } from './crm.ts';
import { CompanyDetailSchema, ContactDetailSchema } from './customer.ts';
import { NotePageSchema } from './notes.ts';

/**
 * The most entries a timeline shows. Each source is already bounded (50 per type), so this only
 * keeps the merged list readable.
 */
export const TIMELINE_LIMIT = 60;

/**
 * Overview sections that may be missing with a warning.
 */
export const OPTIONAL_OVERVIEW_SECTIONS = ['notes'] as const;

/**
 * A warning that one optional section could not be loaded.
 */
export const OverviewWarningSchema = v.strictObject({
  /**
   * The missing section.
   */
  section: v.picklist(OPTIONAL_OVERVIEW_SECTIONS),
  /**
   * Safe, human-readable explanation.
   */
  message: v.string(),
  /**
   * Request identifier to quote when reporting the problem.
   */
  requestId: v.string()
});

/**
 * An overview warning.
 */
export type OverviewWarning = v.InferOutput<typeof OverviewWarningSchema>;

/**
 * Kinds of timeline entry.
 */
export const TIMELINE_KINDS = [
  'call',
  'meeting',
  'deal-opened',
  'deal-won',
  'deal-lost',
  'project-started',
  'note'
] as const;

/**
 * Records a timeline entry links to.
 */
export const TIMELINE_TARGETS = ['deal', 'project', 'note'] as const;

/**
 * One timeline entry.
 */
export const TimelineEntrySchema = v.strictObject({
  /**
   * Stable key: kind plus source id.
   */
  key: v.string(),
  /**
   * What happened.
   */
  kind: v.picklist(TIMELINE_KINDS),
  /**
   * When it happened.
   */
  at: TimestampSchema,
  /**
   * Short title: an activity subject, deal title, project name, or note title. Never body text.
   */
  title: v.string(),
  /**
   * Who did it, when known.
   */
  actor: v.nullable(UserRefSchema),
  /**
   * The record to open, or `null` when the entry has no page of its own (activities).
   */
  target: v.nullable(v.strictObject({ type: v.picklist(TIMELINE_TARGETS), id: IdSchema }))
});

/**
 * A timeline entry.
 */
export type TimelineEntry = v.InferOutput<typeof TimelineEntrySchema>;

/**
 * Members shared by both overview kinds.
 */
const OverviewEntries = {
  /**
   * The first page of linked notes, or `null` when that section failed (see `warnings`).
   */
  notes: v.nullable(NotePageSchema),
  /**
   * Merged history, newest first, at most {@link TIMELINE_LIMIT} entries.
   */
  timeline: v.array(TimelineEntrySchema),
  /**
   * Optional sections that could not be loaded.
   */
  warnings: v.array(OverviewWarningSchema)
};

/**
 * A contact's customer overview.
 */
export const ContactOverviewSchema = v.strictObject({
  /**
   * The core contact read.
   */
  detail: ContactDetailSchema,
  ...OverviewEntries
});

/**
 * A contact overview.
 */
export type ContactOverview = v.InferOutput<typeof ContactOverviewSchema>;

/**
 * A company's customer overview.
 */
export const CompanyOverviewSchema = v.strictObject({
  /**
   * The core company read.
   */
  detail: CompanyDetailSchema,
  ...OverviewEntries
});

/**
 * A company overview.
 */
export type CompanyOverview = v.InferOutput<typeof CompanyOverviewSchema>;
