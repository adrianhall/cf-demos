/**
 * @file The customer overview coordinator: one composite read per contact or company, assembled in
 *   the Application Worker from two **parallel, bounded** Data Worker RPC reads (specification
 *   §8.1, §14 "no N+1 loops"):
 *
 *   1. the core detail (`crm.getContact` / `crm.getCompany`), and
 *   2. the first page of linked notes (`notes.listNotes`).
 *
 *   ## Partial results, and what is never partial
 *
 *   Only the notes section is optional. When its read fails with a **retryable** service error
 *   (`DEPENDENCY_FAILURE`, including an RPC timeout), the overview is returned with `notes: null`
 *   and an explicit warning, so the customer page stays usable during a notes outage. Every other
 *   notes failure — above all `FORBIDDEN` — fails the whole request: an authorization decision must
 *   never be disguised as "data temporarily missing". A core failure always fails the request. Both
 *   reads authorize independently in the Data Worker; the coordinator adds no authorization of its
 *   own and trusts none of the capability hints.
 */

import type { NoteLinkType } from '../../shared/api/notes.ts';
import type { NoteSummary } from '../../shared/api/notes.ts';
import type {
  CompanyOverview,
  ContactOverview,
  OverviewWarning,
  TimelineEntry
} from '../../shared/api/overview.ts';
import { TIMELINE_LIMIT } from '../../shared/api/overview.ts';
import type { Project } from '../../shared/api/projects.ts';
import type { Activity, Deal } from '../../shared/api/sales.ts';
import { isServiceError } from '../../shared/common/errors.ts';
import type { Page } from '../../shared/common/paging.ts';
import type { ActorContext, DataService } from '../../shared/data-service/contract.ts';

/**
 * Notes shown in the overview's first page.
 */
export const OVERVIEW_NOTE_LIMIT = 10;

/**
 * Merge a customer's activities, deal milestones, projects, and notes into one newest-first list.
 *
 * Pure: the inputs are already-authorized, already-bounded projections. Only titles and subjects
 * appear; activity summaries, deal status lines, and note bodies never do.
 *
 * @param sources The bounded source lists; `notes` is `null` when that section failed.
 * @returns At most {@link TIMELINE_LIMIT} entries, newest first, ties broken by key so the order is
 *   stable.
 */
export function buildTimeline(sources: {
  readonly activities: readonly Activity[];
  readonly deals: readonly Deal[];
  readonly projects: readonly Project[];
  readonly notes: readonly NoteSummary[] | null;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const activity of sources.activities) {
    entries.push({
      key: `${activity.type}:${activity.id}`,
      kind: activity.type,
      at: activity.occurredAt,
      title: activity.subject,
      actor: activity.author,
      target: null
    });
  }
  for (const deal of sources.deals) {
    entries.push({
      key: `deal-opened:${deal.id}`,
      kind: 'deal-opened',
      at: deal.createdAt,
      title: deal.title,
      actor: deal.owner,
      target: { type: 'deal', id: deal.id }
    });
    if (deal.status !== 'pending' && deal.closedAt !== null) {
      entries.push({
        key: `deal-${deal.status}:${deal.id}`,
        kind: deal.status === 'won' ? 'deal-won' : 'deal-lost',
        at: deal.closedAt,
        title: deal.title,
        actor: deal.owner,
        target: { type: 'deal', id: deal.id }
      });
    }
  }
  for (const project of sources.projects) {
    entries.push({
      key: `project-started:${project.id}`,
      kind: 'project-started',
      at: project.createdAt,
      title: project.name,
      actor: project.lead,
      target: { type: 'project', id: project.id }
    });
  }
  for (const note of sources.notes ?? []) {
    entries.push({
      key: `note:${note.id}`,
      kind: 'note',
      at: note.createdAt,
      title: note.title,
      actor: note.author,
      target: { type: 'note', id: note.id }
    });
  }
  return entries
    .sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1))
    .slice(0, TIMELINE_LIMIT);
}

/**
 * Read the optional notes section, turning a retryable failure into a warning.
 *
 * @param data The Data Worker client.
 * @param actor The caller.
 * @param link The record whose notes to read.
 * @returns The page, or `null` with a warning.
 * @throws {Error} Any non-retryable failure, including `FORBIDDEN`, unchanged.
 */
async function optionalNotes(
  data: DataService,
  actor: ActorContext,
  link: { readonly type: NoteLinkType; readonly id: string }
): Promise<{ notes: Page<NoteSummary> | null; warnings: OverviewWarning[] }> {
  try {
    const notes = await data.notes.listNotes(actor, {
      linkType: link.type,
      linkId: link.id,
      limit: OVERVIEW_NOTE_LIMIT
    });
    return { notes, warnings: [] };
  } catch (error) {
    if (isServiceError(error) && error.code === 'DEPENDENCY_FAILURE') {
      return {
        notes: null,
        warnings: [
          {
            section: 'notes',
            message: 'Notes are temporarily unavailable. The rest of this page is up to date.',
            requestId: actor.requestId
          }
        ]
      };
    }
    throw error;
  }
}

/**
 * Await both reads, letting a core failure win over a pending notes read.
 *
 * `Promise.all` would also reject on the first failure; this helper exists so the notes promise is
 * always observed (no unhandled rejection) when the core read fails first.
 *
 * @param core The core read.
 * @param notes The optional notes read.
 * @returns Both results.
 * @throws {Error} The core failure, or a non-retryable notes failure.
 */
async function both<TCore>(
  core: Promise<TCore>,
  notes: Promise<{ notes: Page<NoteSummary> | null; warnings: OverviewWarning[] }>
): Promise<[TCore, { notes: Page<NoteSummary> | null; warnings: OverviewWarning[] }]> {
  const [coreResult, notesResult] = await Promise.allSettled([core, notes]);
  if (coreResult.status === 'rejected') {
    throw coreResult.reason;
  }
  if (notesResult.status === 'rejected') {
    throw notesResult.reason;
  }
  return [coreResult.value, notesResult.value];
}

/**
 * A contact's customer overview.
 *
 * @param data The Data Worker client.
 * @param actor The caller.
 * @param contactId The contact.
 * @returns The overview.
 * @throws {Error} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED`, or `DEPENDENCY_FAILURE` from the
 *   core read; `FORBIDDEN` or any other non-retryable failure from the notes read.
 */
export async function contactOverview(
  data: DataService,
  actor: ActorContext,
  contactId: string
): Promise<ContactOverview> {
  const [detail, notes] = await both(
    data.crm.getContact(actor, contactId),
    optionalNotes(data, actor, { type: 'contact', id: contactId })
  );
  return {
    detail,
    notes: notes.notes === null ? null : { ...notes.notes, items: [...notes.notes.items] },
    timeline: buildTimeline({ ...detail, notes: notes.notes?.items ?? null }),
    warnings: notes.warnings
  };
}

/**
 * A company's customer overview.
 *
 * @param data The Data Worker client.
 * @param actor The caller.
 * @param companyId The company.
 * @returns The overview.
 * @throws {Error} As for {@link contactOverview}.
 */
export async function companyOverview(
  data: DataService,
  actor: ActorContext,
  companyId: string
): Promise<CompanyOverview> {
  const [detail, notes] = await both(
    data.crm.getCompany(actor, companyId),
    optionalNotes(data, actor, { type: 'company', id: companyId })
  );
  return {
    detail,
    notes: notes.notes === null ? null : { ...notes.notes, items: [...notes.notes.items] },
    timeline: buildTimeline({ ...detail, notes: notes.notes?.items ?? null }),
    warnings: notes.warnings
  };
}
