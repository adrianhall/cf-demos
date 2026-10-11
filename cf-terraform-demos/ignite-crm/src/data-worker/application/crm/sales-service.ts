/**
 * @file Sales use cases: the pipeline, deals, calls and meetings, contact next actions, the action
 *   stream, and the pipeline summary. Each operation follows the CRM order: validate input →
 *   authorize → (mutations) replay check → domain rules over one read snapshot → one atomic
 *   repository write including audit and idempotency rows. Every referenced record is re-checked by
 *   a guard inside that write, so a contact deleted between the read and the commit rolls the whole
 *   change back instead of leaving a dangling link.
 */

import * as v from 'valibot';
import type { UserRef } from '../../../shared/api/crm.ts';
import { TIMELINE_ACTIVITY_LIMIT } from '../../../shared/api/customer.ts';
import {
  type PipelineReport,
  type PipelineReportFilter,
  PipelineReportFilterSchema
} from '../../../shared/api/reports.ts';
import {
  type ActionItem,
  type ActionStream,
  type Activity,
  type ContactNextAction,
  type CreateActivityInput,
  CreateActivityInputSchema,
  type CreateDealInput,
  CreateDealInputSchema,
  type Deal,
  type DealDetail,
  DealStatusSchema,
  type Pipeline,
  type PipelineSummary,
  type SetNextActionInput,
  SetNextActionInputSchema,
  type Stage,
  type UpdateDealInput,
  UpdateDealInputSchema
} from '../../../shared/api/sales.ts';
import { serviceError } from '../../../shared/common/errors.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE, type Page, PageRequestSchema } from '../../../shared/common/paging.ts';
import type {
  ActorContext,
  DealListOptions,
  MutationMeta,
  SalesPort
} from '../../../shared/data-service/contract.ts';
import { SearchTermSchema, VersionSchema } from '../../../shared/validation/fields.ts';
import {
  applyOutcome,
  calendarDate,
  compareActions,
  isAcceptableDueDate,
  isPastOrPresent,
  lifecycleViolations,
  urgencyOf
} from '../../domain/crm/sales.ts';
import { closedWindow } from '../../domain/reports/reports.ts';
import type { Authorizer } from '../permissions/permissions-service.ts';
import {
  type IdempotencyRepository,
  IdempotentMutation,
  type MutationEnvelope
} from '../shared/mutations.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId, validateIdempotencyKey } from '../shared/validate.ts';
import { decodeCursor, encodeCursor, type ListCriteria } from './crm-service.ts';

/**
 * Most rows the action stream returns.
 */
export const ACTION_STREAM_LIMIT = 100;

/**
 * Number of history entries returned with a deal.
 */
const HISTORY_LIMIT = 20;

/**
 * An active contact as the sales rules need it.
 */
export interface ContactLink {
  /**
   * Contact identifier.
   */
  readonly id: string;
  /**
   * Display name.
   */
  readonly displayName: string;
  /**
   * The contact's company, if any.
   */
  readonly companyId: string | null;
}

/**
 * Deal columns as stored.
 */
export interface DealRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Title.
   */
  readonly title: string;
  /**
   * Company.
   */
  readonly companyId: string | null;
  /**
   * Primary contact.
   */
  readonly primaryContactId: string;
  /**
   * Owner.
   */
  readonly ownerId: string;
  /**
   * Pipeline.
   */
  readonly pipelineId: string;
  /**
   * Stage.
   */
  readonly stageId: string;
  /**
   * Outcome.
   */
  readonly status: Deal['status'];
  /**
   * Status line.
   */
  readonly statusLine: string | null;
  /**
   * Next action text.
   */
  readonly nextActionText: string | null;
  /**
   * Next action date.
   */
  readonly nextActionDate: string | null;
  /**
   * Amount in minor units.
   */
  readonly amountMinor: number;
  /**
   * Currency.
   */
  readonly currency: string;
  /**
   * Expected close date.
   */
  readonly expectedCloseDate: string | null;
  /**
   * Close instant.
   */
  readonly closedAt: string | null;
}

/**
 * An activity row to insert.
 */
export interface NewActivityRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Type.
   */
  readonly type: Activity['type'];
  /**
   * Subject.
   */
  readonly subject: string;
  /**
   * Summary.
   */
  readonly summary: string | null;
  /**
   * When it happened.
   */
  readonly occurredAt: string;
  /**
   * Duration.
   */
  readonly durationMinutes: number | null;
  /**
   * Author.
   */
  readonly authorId: string;
  /**
   * Linked company.
   */
  readonly companyId: string | null;
  /**
   * Linked deal.
   */
  readonly dealId: string | null;
  /**
   * Creation instant.
   */
  readonly createdAt: string;
}

/**
 * A contact next action to write.
 */
export interface NextActionWrite {
  /**
   * Follow-up identifier (new for an insert, existing for a replace).
   */
  readonly id: string;
  /**
   * Contact.
   */
  readonly contactId: string;
  /**
   * Assignee.
   */
  readonly assigneeId: string;
  /**
   * Text.
   */
  readonly text: string;
  /**
   * Due date, or `null` for ASAP.
   */
  readonly dueDate: string | null;
  /**
   * Version being replaced, or `null` to insert.
   */
  readonly expectedVersion: number | null;
  /**
   * Instant of the change.
   */
  readonly at: string;
}

/**
 * An action-stream candidate before urgency is computed.
 */
export type ActionCandidate = Omit<ActionItem, 'urgency'>;

/**
 * Storage port for the sales use cases.
 */
export interface SalesRepository extends IdempotencyRepository {
  /**
   * The (single, fixed) sales pipeline.
   *
   * @returns The pipeline, or `null` when unmigrated.
   */
  pipeline(): Promise<Pipeline | null>;
  /**
   * Active users, by name.
   *
   * @returns References.
   */
  activeUsers(): Promise<UserRef[]>;
  /**
   * One active user.
   *
   * @param userId User id.
   * @returns The reference, or `null` when absent or suspended.
   */
  activeUser(userId: string): Promise<UserRef | null>;
  /**
   * Any user, active or suspended, for labelling a report filter.
   *
   * @param userId User id.
   * @returns The reference, or `null` when no such user exists.
   */
  userRef(userId: string): Promise<UserRef | null>;
  /**
   * Active contacts among the given ids.
   *
   * @param ids Contact ids.
   * @returns The active ones, in any order.
   */
  contactLinks(ids: readonly string[]): Promise<ContactLink[]>;
  /**
   * An active company's id and name.
   *
   * @param id Company id.
   * @returns The reference, or `null`.
   */
  companyRef(id: string): Promise<{ id: string; name: string } | null>;
  /**
   * One page of active deals ordered by lower-cased title then id.
   *
   * @param criteria Search and keyset position.
   * @param filters Outcome and stage filters (`null` for either means any).
   * @returns Up to `limit + 1` deals with sort keys.
   */
  listDeals(
    criteria: ListCriteria,
    filters: { readonly status: Deal['status'] | null; readonly stageId: string | null }
  ): Promise<Array<Deal & { sortKey: string }>>;
  /**
   * Read an active deal.
   *
   * @param id Deal id.
   * @returns The deal, or `null`.
   */
  getDeal(id: string): Promise<Deal | null>;
  /**
   * Active deals whose primary contact is the given contact, newest first.
   *
   * @param contactId Contact id.
   * @param limit Maximum rows.
   * @returns Deals.
   */
  contactDeals(contactId: string, limit: number): Promise<Deal[]>;
  /**
   * Active deals filed under a company, newest first.
   *
   * @param companyId Company id.
   * @param limit Maximum rows.
   * @returns Deals.
   */
  companyDeals(companyId: string, limit: number): Promise<Deal[]>;
  /**
   * Activities linked to a record, newest first. For a company this includes activities linked to
   * the company directly, to any of its contacts, or to any of its deals.
   *
   * @param target What to list for.
   * @param limit Maximum rows.
   * @returns Activities with their linked contacts, in a fixed number of queries.
   */
  activitiesFor(
    target: { readonly type: 'contact' | 'company' | 'deal'; readonly id: string },
    limit: number
  ): Promise<Activity[]>;
  /**
   * A contact's open next action.
   *
   * @param contactId Contact id.
   * @returns The action, or `null`.
   */
  contactNextAction(contactId: string): Promise<ContactNextAction | null>;
  /**
   * Action-stream candidates for a user: their open contact actions and their pending deals' next
   * actions, each list at most `limit` long and ordered by date.
   *
   * @param userId The user.
   * @param limit Maximum rows per source.
   * @returns Candidates.
   */
  actionCandidates(userId: string, limit: number): Promise<ActionCandidate[]>;
  /**
   * Deal counts and totals for a pipeline.
   *
   * @param pipelineId Pipeline id.
   * @param filter Optional owner and a half-open UTC window `[closedFrom, closedBefore)` applied to
   *   won/lost deals only; omitted members are unbounded.
   * @returns Pending totals by stage id, and won/lost totals.
   */
  pipelineTotals(
    pipelineId: string,
    filter?: {
      readonly ownerId: string | null;
      readonly closedFrom: string | null;
      readonly closedBefore: string | null;
    }
  ): Promise<{
    byStage: ReadonlyMap<string, { count: number; amountMinor: number }>;
    won: { count: number; amountMinor: number };
    lost: { count: number; amountMinor: number };
  }>;
  /**
   * Recent history for an entity.
   *
   * @param entityType Entity type.
   * @param entityId Entity id.
   * @param limit Maximum entries.
   * @returns Entries, newest first.
   */
  history(entityType: string, entityId: string, limit: number): Promise<DealDetail['history']>;
  /**
   * Atomically insert a deal and the envelope rows, guarding that its contact, company, and owner
   * are still active.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `NOT_FOUND` when a guard fails, or `DEPENDENCY_FAILURE`.
   */
  insertDeal(write: { deal: DealRow; at: string; envelope: MutationEnvelope }): Promise<void>;
  /**
   * Atomically replace a deal's fields if it is still at `expectedVersion`, guarding its links.
   *
   * @param write The new state.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `NOT_FOUND`, or `DEPENDENCY_FAILURE`.
   */
  updateDeal(write: {
    deal: DealRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically insert an activity, its contact links, and the envelope rows, guarding that every
   * linked record is still active.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `NOT_FOUND` when any linked record vanished, or `DEPENDENCY_FAILURE`.
   */
  insertActivity(write: {
    activity: NewActivityRow;
    contactIds: readonly string[];
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically insert or replace a contact's open next action.
   *
   * @param write The action.
   * @param envelope Audit and idempotency rows.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH` when the replaced action changed, `CONFLICT` when another
   *   open action was inserted concurrently, `NOT_FOUND` when the contact vanished, or
   *   `DEPENDENCY_FAILURE`.
   */
  saveNextAction(write: NextActionWrite, envelope: MutationEnvelope): Promise<void>;
  /**
   * Atomically mark an open next action done if it is still at `expectedVersion`.
   *
   * @param write The follow-up id, version, and instant.
   * @param envelope Audit and idempotency rows.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH` or `DEPENDENCY_FAILURE`.
   */
  completeNextAction(
    write: { id: string; expectedVersion: number; at: string },
    envelope: MutationEnvelope
  ): Promise<void>;
}

/**
 * Installation settings the sales rules need.
 */
export interface SalesSettings {
  /**
   * IANA time zone that defines "today".
   */
  readonly timezone: string;
  /**
   * ISO 4217 installation currency.
   */
  readonly currencyCode: string;
}

/**
 * Schema for deal list options crossing RPC.
 */
const DealListOptionsSchema = v.strictObject({
  q: v.optional(SearchTermSchema),
  status: v.optional(DealStatusSchema),
  stageId: v.optional(IdSchema),
  ...PageRequestSchema.entries
});

/**
 * Schema for the expected version of a contact next action (`null` = none expected).
 */
const ExpectedNextActionVersionSchema = v.nullable(VersionSchema);

/**
 * Throw a validation failure on one field.
 *
 * @param field Field name.
 * @param message Message.
 * @param requestId Request identifier.
 * @returns Never.
 * @throws {Error} Always: a `VALIDATION_FAILED` service error.
 */
function invalid(field: string, message: string, requestId: string): never {
  throw serviceError('VALIDATION_FAILED', message, { requestId, fields: { [field]: message } });
}

/**
 * Project a deal onto its stored columns.
 *
 * @param deal The deal.
 * @returns The row.
 */
function toRow(deal: Deal): DealRow {
  return {
    id: deal.id,
    title: deal.title,
    companyId: deal.company?.id ?? null,
    primaryContactId: deal.primaryContact.id,
    ownerId: deal.owner.id,
    pipelineId: deal.pipeline.id,
    stageId: deal.stage.id,
    status: deal.status,
    statusLine: deal.statusLine,
    nextActionText: deal.nextActionText,
    nextActionDate: deal.nextActionDate,
    amountMinor: deal.amountMinor,
    currency: deal.currency,
    expectedCloseDate: deal.expectedCloseDate,
    closedAt: deal.closedAt
  };
}

/**
 * Sales application service.
 */
export class SalesService implements SalesPort {
  /**
   * @param repository Storage port.
   * @param authorizer Permissions capability.
   * @param runtime Clock and id source.
   * @param settings Installation time zone and currency.
   */
  constructor(
    private readonly repository: SalesRepository,
    private readonly authorizer: Authorizer,
    private readonly runtime: Runtime,
    private readonly settings: SalesSettings
  ) {}

  /**
   * @inheritdoc
   */
  async getPipeline(actor: ActorContext): Promise<Pipeline> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'crm.read');
    return this.requirePipeline(caller.requestId);
  }

  /**
   * @inheritdoc
   */
  async listAssignees(actor: ActorContext): Promise<UserRef[]> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'crm.read');
    return this.repository.activeUsers();
  }

  /**
   * @inheritdoc
   */
  async listDeals(actor: ActorContext, options: DealListOptions): Promise<Page<Deal>> {
    const caller = validateActor(actor);
    const parsed = validate(
      DealListOptionsSchema,
      options ?? { limit: DEFAULT_PAGE_SIZE },
      caller.requestId
    );
    const criteria: ListCriteria = {
      q: parsed.q?.toLowerCase() ?? null,
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, caller.requestId)
    };
    await this.authorizer.require(caller, 'crm.read');
    if (parsed.stageId !== undefined) {
      // An unknown stage is a field error, not an empty page, so a stale bookmark is explained.
      this.stageIn(await this.requirePipeline(caller.requestId), parsed.stageId, caller.requestId);
    }
    const rows = await this.repository.listDeals(criteria, {
      status: parsed.status ?? null,
      stageId: parsed.stageId ?? null
    });
    const visible = rows.slice(0, criteria.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(({ sortKey: _sortKey, ...deal }) => deal),
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? encodeCursor(last.sortKey, last.id)
          : null
    };
  }

  /**
   * @inheritdoc
   */
  async getDeal(actor: ActorContext, id: string): Promise<DealDetail> {
    const caller = validateActor(actor);
    const dealId = validateId(id, caller.requestId);
    await this.authorizer.require(caller, 'crm.read');
    const deal = await this.repository.getDeal(dealId);
    if (deal === null) {
      throw serviceError('NOT_FOUND', 'Deal not found.', { requestId: caller.requestId });
    }
    const [activities, history] = await Promise.all([
      this.repository.activitiesFor({ type: 'deal', id: dealId }, TIMELINE_ACTIVITY_LIMIT),
      this.repository.history('deal', dealId, HISTORY_LIMIT)
    ]);
    return { deal, activities, history };
  }

  /**
   * @inheritdoc
   */
  async createDeal(actor: ActorContext, input: CreateDealInput, meta: MutationMeta): Promise<Deal> {
    const caller = validateActor(actor);
    const fields = validate(CreateDealInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');
    const ownerId = fields.ownerId ?? caller.userId;
    if (ownerId !== caller.userId) {
      await this.authorizer.require(caller, 'crm.assign');
    }

    const mutation = await IdempotentMutation.begin(
      'crm.createDeal',
      caller,
      { idempotencyKey: key },
      fields,
      this.runtime
    );
    const replayed = await mutation.replay<Deal>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }

    const now = this.runtime.now();
    const at = now.toISOString();
    const today = calendarDate(now, this.settings.timezone);
    if (!isAcceptableDueDate(fields.nextActionDate, today)) {
      invalid('nextActionDate', 'The next action date cannot be in the past.', caller.requestId);
    }
    const pipeline = await this.requirePipeline(caller.requestId);
    const stage = this.stageIn(
      pipeline,
      fields.stageId ?? pipeline.stages[0]?.id,
      caller.requestId
    );
    const contact = await this.requireContact(
      fields.primaryContactId,
      'primaryContactId',
      caller.requestId
    );
    const company = await this.dealCompany(
      fields.companyId === undefined ? contact.companyId : fields.companyId,
      contact,
      caller.requestId
    );
    const owner = await this.requireAssignee(ownerId, caller.requestId);

    const deal: Deal = {
      id: this.runtime.newId(),
      title: fields.title,
      status: 'pending',
      stage,
      pipeline: { id: pipeline.id, name: pipeline.name },
      company,
      primaryContact: { id: contact.id, displayName: contact.displayName },
      owner,
      statusLine: fields.statusLine,
      nextActionText: fields.nextActionText,
      nextActionDate: fields.nextActionDate,
      amountMinor: fields.amountMinor,
      currency: this.settings.currencyCode,
      expectedCloseDate: fields.expectedCloseDate,
      closedAt: null,
      project: null,
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.repository.insertDeal({
      deal: toRow(deal),
      at,
      envelope: mutation.envelope(
        deal,
        [
          mutation.audit(
            'crm',
            'deal',
            deal.id,
            'created',
            { stage: stage.key, ownerId: owner.id, amountMinor: deal.amountMinor },
            at
          )
        ],
        now
      )
    });
    return deal;
  }

  /**
   * @inheritdoc
   */
  async updateDeal(
    actor: ActorContext,
    id: string,
    input: UpdateDealInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Deal> {
    const caller = validateActor(actor);
    const dealId = validateId(id, caller.requestId);
    const fields = validate(UpdateDealInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.updateDeal',
      caller,
      { idempotencyKey: key },
      { dealId, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<Deal>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    if (fields.ownerId !== undefined) {
      await this.authorizer.require(caller, 'crm.assign');
    }
    const current = await this.repository.getDeal(dealId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Deal not found.', { requestId: caller.requestId });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The deal was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }
    // A converted deal is the immutable source of delivery work. Reopening or losing it would
    // leave an active project whose source no longer satisfies the conversion invariant.
    if (current.project !== null && fields.status !== undefined && fields.status !== 'won') {
      throw serviceError('CONFLICT', 'A converted deal must remain won.', {
        requestId: caller.requestId
      });
    }
    let owner = current.owner;
    if (fields.ownerId !== undefined && fields.ownerId !== current.owner.id) {
      owner = await this.requireAssignee(fields.ownerId, caller.requestId);
    }

    const now = this.runtime.now();
    const at = now.toISOString();
    const today = calendarDate(now, this.settings.timezone);
    let stage = current.stage;
    if (fields.stageId !== undefined && fields.stageId !== current.stage.id) {
      const pipeline = await this.requirePipeline(caller.requestId);
      stage = this.stageIn(pipeline, fields.stageId, caller.requestId);
    }
    // The primary contact and company are validated together: when either changes, the (new or
    // current) contact must work at the (new or current) company.
    let primaryContact = current.primaryContact;
    let company = current.company;
    if (fields.primaryContactId !== undefined || fields.companyId !== undefined) {
      const contact = await this.requireContact(
        fields.primaryContactId ?? current.primaryContact.id,
        'primaryContactId',
        caller.requestId
      );
      primaryContact = { id: contact.id, displayName: contact.displayName };
      company = await this.dealCompany(
        fields.companyId === undefined ? (current.company?.id ?? null) : fields.companyId,
        contact,
        caller.requestId
      );
    }

    const lifecycle = applyOutcome(
      {
        status: current.status,
        nextActionText:
          fields.nextActionText === undefined ? current.nextActionText : fields.nextActionText,
        nextActionDate:
          fields.nextActionDate === undefined ? current.nextActionDate : fields.nextActionDate,
        closedAt: current.closedAt
      },
      fields.status ?? current.status,
      at
    );
    const requestedAction =
      fields.status !== undefined
      && fields.status !== 'pending'
      && fields.status !== current.status
      && (typeof fields.nextActionText === 'string' || typeof fields.nextActionDate === 'string');
    if (requestedAction) {
      invalid('nextActionText', 'Only an open deal can have a next action.', caller.requestId);
    }
    if (lifecycle.status !== 'pending' && typeof fields.expectedCloseDate === 'string') {
      invalid(
        'expectedCloseDate',
        'Only an open deal can have an expected close date.',
        caller.requestId
      );
    }
    const violations = lifecycleViolations(
      lifecycle,
      fields.nextActionDate !== undefined && fields.nextActionDate !== current.nextActionDate,
      today
    );
    const [field, message] = Object.entries(violations)[0] ?? [];
    if (field !== undefined && message !== undefined) {
      invalid(field, message, caller.requestId);
    }

    const deal: Deal = {
      ...current,
      title: fields.title ?? current.title,
      status: lifecycle.status,
      stage,
      company,
      primaryContact,
      owner,
      statusLine: fields.statusLine === undefined ? current.statusLine : fields.statusLine,
      nextActionText: lifecycle.nextActionText,
      nextActionDate: lifecycle.nextActionDate,
      amountMinor: fields.amountMinor ?? current.amountMinor,
      expectedCloseDate:
        lifecycle.status !== 'pending'
          ? null
          : fields.expectedCloseDate === undefined
            ? current.expectedCloseDate
            : fields.expectedCloseDate,
      closedAt: lifecycle.closedAt,
      version: current.version + 1,
      updatedAt: at
    };
    const action =
      deal.status === current.status
        ? 'updated'
        : deal.status === 'pending'
          ? 'reopened'
          : deal.status;
    await this.repository.updateDeal({
      deal: toRow(deal),
      expectedVersion: version,
      at,
      envelope: mutation.envelope(
        deal,
        [
          mutation.audit(
            'crm',
            'deal',
            dealId,
            action,
            {
              fields: Object.keys(fields).sort().join(','),
              stage: deal.stage.key,
              status: deal.status,
              version: deal.version
            },
            at
          )
        ],
        now
      )
    });
    return deal;
  }

  /**
   * @inheritdoc
   */
  async createActivity(
    actor: ActorContext,
    input: CreateActivityInput,
    meta: MutationMeta
  ): Promise<Activity> {
    const caller = validateActor(actor);
    const fields = validate(CreateActivityInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.createActivity',
      caller,
      { idempotencyKey: key },
      fields,
      this.runtime
    );
    const replayed = await mutation.replay<Activity>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const now = this.runtime.now();
    if (!isPastOrPresent(fields.occurredAt, now)) {
      invalid(
        'occurredAt',
        'An activity records something that happened; it cannot be in the future.',
        caller.requestId
      );
    }

    // Every link is validated against one snapshot before anything is written. An absent or
    // deleted target is reported as a field error and nothing is stored.
    const found = await this.repository.contactLinks(fields.contactIds);
    const byId = new Map(found.map((contact) => [contact.id, contact]));
    if (fields.contactIds.some((contactId) => !byId.has(contactId))) {
      invalid('contactIds', 'One or more selected contacts no longer exist.', caller.requestId);
    }
    const company =
      fields.companyId === null ? null : await this.repository.companyRef(fields.companyId);
    if (fields.companyId !== null && company === null) {
      invalid('companyId', 'The selected company does not exist.', caller.requestId);
    }
    const deal = fields.dealId === null ? null : await this.repository.getDeal(fields.dealId);
    if (fields.dealId !== null && deal === null) {
      invalid('dealId', 'The selected deal does not exist.', caller.requestId);
    }
    if (company !== null && deal?.company != null && deal.company.id !== company.id) {
      invalid(
        'dealId',
        'The selected deal belongs to a different company than the activity.',
        caller.requestId
      );
    }

    const at = now.toISOString();
    const author = (await this.repository.activeUser(caller.userId)) ?? {
      id: caller.userId,
      displayName: caller.email
    };
    const row: NewActivityRow = {
      id: this.runtime.newId(),
      type: fields.type,
      subject: fields.subject,
      summary: fields.summary,
      occurredAt: fields.occurredAt,
      durationMinutes: fields.durationMinutes,
      authorId: caller.userId,
      companyId: company?.id ?? null,
      dealId: deal?.id ?? null,
      createdAt: at
    };
    const activity: Activity = {
      id: row.id,
      type: row.type,
      subject: row.subject,
      summary: row.summary,
      occurredAt: row.occurredAt,
      durationMinutes: row.durationMinutes,
      author,
      contacts: fields.contactIds.map((contactId) => ({
        id: contactId,
        displayName: byId.get(contactId)?.displayName ?? '',
        deleted: false
      })),
      company,
      deal: deal === null ? null : { id: deal.id, title: deal.title },
      createdAt: at
    };
    await this.repository.insertActivity({
      activity: row,
      contactIds: fields.contactIds,
      envelope: mutation.envelope(
        activity,
        [
          mutation.audit(
            'crm',
            'activity',
            row.id,
            'created',
            {
              type: row.type,
              contacts: fields.contactIds.length,
              companyId: row.companyId,
              dealId: row.dealId
            },
            at
          )
        ],
        now
      )
    });
    return activity;
  }

  /**
   * @inheritdoc
   */
  async setContactNextAction(
    actor: ActorContext,
    contactId: string,
    input: SetNextActionInput,
    expectedVersion: number | null,
    meta: MutationMeta
  ): Promise<ContactNextAction> {
    const caller = validateActor(actor);
    const id = validateId(contactId, caller.requestId);
    const fields = validate(SetNextActionInputSchema, input, caller.requestId);
    const version = validate(ExpectedNextActionVersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.setContactNextAction',
      caller,
      { idempotencyKey: key },
      { contactId: id, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<ContactNextAction>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    await this.requireContactOrNotFound(id, caller.requestId);
    const now = this.runtime.now();
    if (!isAcceptableDueDate(fields.dueDate, calendarDate(now, this.settings.timezone))) {
      invalid('dueDate', 'The next action date cannot be in the past.', caller.requestId);
    }
    const current = await this.repository.contactNextAction(id);
    if ((current?.version ?? null) !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The next action was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }

    const at = now.toISOString();
    const assignee = await this.requireAssignee(caller.userId, caller.requestId);
    const result: ContactNextAction = {
      id: current?.id ?? this.runtime.newId(),
      text: fields.text,
      dueDate: fields.dueDate,
      assignee,
      version: (current?.version ?? 0) + 1,
      updatedAt: at
    };
    await this.repository.saveNextAction(
      {
        id: result.id,
        contactId: id,
        assigneeId: caller.userId,
        text: fields.text,
        dueDate: fields.dueDate,
        expectedVersion: version,
        at
      },
      mutation.envelope(
        result,
        [
          mutation.audit(
            'crm',
            'contact',
            id,
            'next-action-set',
            { dueDate: fields.dueDate, followUpId: result.id },
            at
          )
        ],
        now
      )
    );
    return result;
  }

  /**
   * @inheritdoc
   */
  async completeContactNextAction(
    actor: ActorContext,
    contactId: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<ContactNextAction> {
    const caller = validateActor(actor);
    const id = validateId(contactId, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.completeContactNextAction',
      caller,
      { idempotencyKey: key },
      { contactId: id, version },
      this.runtime
    );
    const replayed = await mutation.replay<ContactNextAction>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    await this.requireContactOrNotFound(id, caller.requestId);
    const current = await this.repository.contactNextAction(id);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'This contact has no open next action.', {
        requestId: caller.requestId
      });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The next action was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }
    const now = this.runtime.now();
    const at = now.toISOString();
    const result: ContactNextAction = { ...current, version: current.version + 1, updatedAt: at };
    await this.repository.completeNextAction(
      { id: current.id, expectedVersion: version, at },
      mutation.envelope(
        result,
        [
          mutation.audit(
            'crm',
            'contact',
            id,
            'next-action-completed',
            { followUpId: current.id },
            at
          )
        ],
        now
      )
    );
    return result;
  }

  /**
   * @inheritdoc
   */
  async actionStream(actor: ActorContext): Promise<ActionStream> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'crm.read');
    const today = calendarDate(this.runtime.now(), this.settings.timezone);
    const candidates = await this.repository.actionCandidates(caller.userId, ACTION_STREAM_LIMIT);
    return {
      today,
      items: [...candidates]
        .sort(compareActions)
        .slice(0, ACTION_STREAM_LIMIT)
        .map((item) => ({ ...item, urgency: urgencyOf(item.dueDate, today) }))
    };
  }

  /**
   * @inheritdoc
   */
  async pipelineSummary(actor: ActorContext): Promise<PipelineSummary> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'report.read');
    const pipeline = await this.requirePipeline(caller.requestId);
    return this.summarise(pipeline, await this.repository.pipelineTotals(pipeline.id));
  }

  /**
   * @inheritdoc
   */
  async pipelineReport(actor: ActorContext, filter: PipelineReportFilter): Promise<PipelineReport> {
    const caller = validateActor(actor);
    const parsed = validate(PipelineReportFilterSchema, filter ?? {}, caller.requestId);
    await this.authorizer.require(caller, 'report.read');
    let owner: UserRef | null = null;
    if (parsed.ownerId !== undefined) {
      // Suspended owners still own deals, so resolve by id regardless of status.
      owner = await this.repository.userRef(parsed.ownerId);
      if (owner === null) {
        throw serviceError('VALIDATION_FAILED', 'That person is not on the team.', {
          requestId: caller.requestId,
          fields: { ownerId: 'That person is not on the team.' }
        });
      }
    }
    const pipeline = await this.requirePipeline(caller.requestId);
    const window = closedWindow(parsed.closedFrom, parsed.closedTo, this.settings.timezone);
    const totals = await this.repository.pipelineTotals(pipeline.id, {
      ownerId: owner?.id ?? null,
      closedFrom: window.from,
      closedBefore: window.before
    });
    return {
      ...this.summarise(pipeline, totals),
      filter: {
        owner,
        closedFrom: parsed.closedFrom ?? null,
        closedTo: parsed.closedTo ?? null
      }
    };
  }

  /**
   * Shape stored totals as a pipeline summary, with every stage present in stage order.
   *
   * @param pipeline The pipeline.
   * @param totals Totals from the repository.
   * @returns The summary.
   */
  private summarise(
    pipeline: Pipeline,
    totals: Awaited<ReturnType<SalesRepository['pipelineTotals']>>
  ): PipelineSummary {
    const stages = pipeline.stages.map((stage) => ({
      stage,
      ...(totals.byStage.get(stage.id) ?? { count: 0, amountMinor: 0 })
    }));
    return {
      pipeline: { id: pipeline.id, name: pipeline.name },
      currency: this.settings.currencyCode,
      stages,
      open: stages.reduce(
        (sum, item) => ({
          count: sum.count + item.count,
          amountMinor: sum.amountMinor + item.amountMinor
        }),
        { count: 0, amountMinor: 0 }
      ),
      won: totals.won,
      lost: totals.lost
    };
  }

  /**
   * The pipeline, which the migration seeds.
   *
   * @param requestId Request identifier.
   * @returns The pipeline.
   * @throws {Error} `DEPENDENCY_FAILURE` when the database has not been migrated.
   */
  private async requirePipeline(requestId: string): Promise<Pipeline> {
    const pipeline = await this.repository.pipeline();
    if (pipeline === null || pipeline.stages.length === 0) {
      throw serviceError('DEPENDENCY_FAILURE', 'The sales pipeline is not configured.', {
        requestId
      });
    }
    return pipeline;
  }

  /**
   * Find a stage in the pipeline.
   *
   * @param pipeline The pipeline.
   * @param stageId Stage id.
   * @param requestId Request identifier.
   * @returns The stage.
   * @throws {Error} `VALIDATION_FAILED` on `stageId` when it is not in the pipeline.
   */
  private stageIn(pipeline: Pipeline, stageId: string | undefined, requestId: string): Stage {
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
    return stage ?? invalid('stageId', 'Choose a stage from the sales pipeline.', requestId);
  }

  /**
   * An active contact, reported as a field error when absent.
   *
   * @param id Contact id.
   * @param field Field to report on.
   * @param requestId Request identifier.
   * @returns The contact.
   * @throws {Error} `VALIDATION_FAILED` when absent or deleted.
   */
  private async requireContact(id: string, field: string, requestId: string): Promise<ContactLink> {
    const [contact] = await this.repository.contactLinks([id]);
    return contact ?? invalid(field, 'The selected contact does not exist.', requestId);
  }

  /**
   * An active contact addressed by the URL, reported as not found when absent.
   *
   * @param id Contact id.
   * @param requestId Request identifier.
   * @returns Once found.
   * @throws {Error} `NOT_FOUND` when absent or deleted.
   */
  private async requireContactOrNotFound(id: string, requestId: string): Promise<void> {
    const [contact] = await this.repository.contactLinks([id]);
    if (contact === undefined) {
      throw serviceError('NOT_FOUND', 'Contact not found.', { requestId });
    }
  }

  /**
   * Resolve and check a deal's company against its primary contact.
   *
   * A deal's company is optional. When set, the primary contact must currently work there: the
   * person a deal is sold to is someone at the customer (introduction §1.3).
   *
   * @param companyId Requested company, or `null`.
   * @param contact The primary contact.
   * @param requestId Request identifier.
   * @returns The company reference, or `null`.
   * @throws {Error} `VALIDATION_FAILED` when the company is absent or the contact is not there.
   */
  private async dealCompany(
    companyId: string | null,
    contact: ContactLink,
    requestId: string
  ): Promise<{ id: string; name: string } | null> {
    if (companyId === null) {
      return null;
    }
    const company = await this.repository.companyRef(companyId);
    if (company === null) {
      return invalid('companyId', 'The selected company does not exist.', requestId);
    }
    if (contact.companyId !== companyId) {
      return invalid(
        'primaryContactId',
        'The primary contact must work at the deal’s company.',
        requestId
      );
    }
    return company;
  }

  /**
   * An active user a deal may be assigned to.
   *
   * @param userId User id.
   * @param requestId Request identifier.
   * @returns The user reference.
   * @throws {Error} `VALIDATION_FAILED` on `ownerId` when the user is absent or inactive.
   */
  private async requireAssignee(userId: string, requestId: string): Promise<UserRef> {
    const user = await this.repository.activeUser(userId);
    return user ?? invalid('ownerId', 'The owner must be an active user.', requestId);
  }
}
