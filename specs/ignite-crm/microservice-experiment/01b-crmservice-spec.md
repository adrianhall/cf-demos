# Ignite CRM — CRM data service specification

## 1. Purpose and boundary

The CRM service owns companies, contacts, deals, sales follow-up actions, calls, meetings, their
multi-record links, tags, pipeline configuration, and pipeline reporting. It owns the sales history
and deal half of deal-to-project conversion.

It does not own users/roles, project/task state, Markdown notes, HTTP, MCP tools, calendar
scheduling, or external integrations. Notes are never activity rows. See the system spec for shared
rules.

## 2. Architecture and dependencies

```text
CrmEntrypoint
  → CrmApplicationService
    → pure company/contact/deal/activity/action domains
    → CRM repository ports → CRM_DB adapters
    → PermissionsPort (RPC binding)
```

The only service binding is `PERMISSIONS`. CRM never calls Notes or Projects; the API/MCP
composition layers own cross-service link validation, hydration, and conversion orchestration.

## 3. RPC contract

The exported contract is split by aggregate but implemented by one `CrmEntrypoint`. All methods take
`ActorContext` first and authorize internally.

```ts
export abstract class CrmContract {
  abstract health(): Promise<Health>;
  abstract getContact(actor: ActorContext, id: string): Promise<Contact>;
  abstract listContacts(
    actor: ActorContext,
    query: ContactQuery,
    page: PageRequest
  ): Promise<Page<ContactSummary>>;
  abstract createContact(
    actor: ActorContext,
    input: CreateContactInput,
    meta: MutationMeta
  ): Promise<Contact>;
  abstract updateContact(
    actor: ActorContext,
    id: string,
    input: UpdateContactInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Contact>;
  abstract deleteContact(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<DeletionResult>;
  abstract getCompany(actor: ActorContext, id: string): Promise<Company>;
  abstract listCompanies(
    actor: ActorContext,
    query: CompanyQuery,
    page: PageRequest
  ): Promise<Page<CompanySummary>>;
  abstract createCompany(
    actor: ActorContext,
    input: CreateCompanyInput,
    meta: MutationMeta
  ): Promise<Company>;
  abstract updateCompany(
    actor: ActorContext,
    id: string,
    input: UpdateCompanyInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Company>;
  abstract getDeal(actor: ActorContext, id: string): Promise<Deal>;
  abstract listDeals(
    actor: ActorContext,
    query: DealQuery,
    page: PageRequest
  ): Promise<Page<DealSummary>>;
  abstract createDeal(
    actor: ActorContext,
    input: CreateDealInput,
    meta: MutationMeta
  ): Promise<Deal>;
  abstract updateDeal(
    actor: ActorContext,
    id: string,
    input: UpdateDealInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Deal>;
  abstract setDealOutcome(
    actor: ActorContext,
    id: string,
    outcome: 'won' | 'lost',
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Deal>;
  abstract getDealConversionSnapshot(
    actor: ActorContext,
    dealId: string
  ): Promise<DealConversionSnapshot>;
  abstract recordProjectConversion(
    actor: ActorContext,
    input: RecordProjectConversionInput,
    meta: MutationMeta
  ): Promise<Deal>;
  abstract createActivity(
    actor: ActorContext,
    input: CreateActivityInput,
    meta: MutationMeta
  ): Promise<Activity>;
  abstract updateActivity(
    actor: ActorContext,
    id: string,
    input: UpdateActivityInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Activity>;
  abstract listActivities(
    actor: ActorContext,
    query: ActivityQuery,
    page: PageRequest
  ): Promise<Page<Activity>>;
  abstract createFollowUp(
    actor: ActorContext,
    input: CreateFollowUpInput,
    meta: MutationMeta
  ): Promise<FollowUp>;
  abstract completeFollowUp(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<FollowUp>;
  abstract getActionStream(
    actor: ActorContext,
    query: ActionStreamQuery,
    page: PageRequest
  ): Promise<Page<ActionStreamItem>>;
  abstract validateResourceRefs(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ValidatedResourceRef[]>;
  abstract getResourceLabels(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ResourceLabel[]>;
  abstract getPipelineSummary(
    actor: ActorContext,
    query: PipelineSummaryQuery
  ): Promise<PipelineSummary>;
  abstract listAudit(
    actor: ActorContext,
    filter: AuditFilter,
    page: PageRequest
  ): Promise<Page<CrmAuditEvent>>;
}
```

Batch ref methods accept only `contact`, `company`, `deal`, `activity`, maximum 100, preserve order,
and return non-enumerating `NOT_FOUND` if any target is missing/invisible.

## 4. Domain model

### 4.1 Companies

`Company`: `id`, `name`, structured business address (`line1`, `line2?`, `city`, `region?`,
`postalCode`, `countryCode`), optional `stockSymbol`, optional `companiesHouseUrl`, optional
`primaryContactId`, `version`, timestamps/deletion metadata.

Rules:

- Name is 1–200 characters. Duplicate names are allowed but normalized-name search warns rather than
  silently merging.
- `companiesHouseUrl`, when present, must be HTTPS on
  `find-and-update.company-information.service.gov.uk`. Store the canonical URL, not arbitrary text.
- `stockSymbol` is uppercase 1–16 characters (`A-Z`, digits, `.`, `-`, `:`).
- Primary contact must be active and currently linked to that company.
- Creating a contact with `companyName` and no `companyId` reuses an exact normalized-name company
  if exactly one exists; otherwise creates one. Ambiguous duplicates are `CONFLICT` and require ID.
- Deleting/moving the primary contact chooses the oldest remaining active company contact by
  `(created_at, id)`; if none, clears it. This deterministic rule is transactional and audited.

### 4.2 Contacts

`Contact`: `id`, at least one of `firstName`, `lastName`, `companyId`; optional `jobTitle`, `email`,
`phone`, `ownerId`; `tags[]`; `version`; timestamps/deletion metadata.

One contact belongs to at most one company in release one. Email is not globally unique because
shared mailboxes and duplicate lead imports occur. Tags are normalized trim/lowercase for uniqueness
but preserve first display spelling.

### 4.3 Deals and pipelines

`Deal`: `id`, `title`, `companyId?`, `primaryContactId`, `ownerId`, `pipelineId`, `stageId`, status
`pending|won|lost`, user-defined `statusLine?`, `nextActionText?`, `nextActionDate?`, `amountMinor`,
`currency`, `expectedCloseDate?`, `closedAt?`, `projectId?`, `version`, timestamps/deletion
metadata.

- Primary contact need not equal company primary contact. If `companyId` is set, the primary contact
  must currently belong to that company; when `companyId` is absent, the contact may be uncompanyed.
- Status line maximum 160. Next-action text/date are both null or both set.
- Only pending deals carry a next action and expected close date. Winning/losing clears next action
  and stamps `closedAt` in one transaction.
- Fixed status drives reporting and conversion; status line is display-only.
- Deal amount is non-negative integer minor units. One installation currency is enforced in release
  one.
- One pipeline is seeded with ordered stages (`lead`, `qualified`, `proposal`, `negotiation`). Stage
  is required only while pending. Pipeline editing is not release-one UI scope.
- `projectId` is unique and writeable only through `recordProjectConversion`; a deal must be won.

### 4.4 Activities

An `Activity` is a call or meeting record: `id`, `type`, `subject`, optional `summary`,
`occurredAt`, `durationMinutes?`, `authorId`, `contactIds` (one or more), optional `companyId`,
optional `dealId`, `version`, timestamps/deletion metadata.

- At least one contact is required.
- Every linked contact must be active. Linked contacts need not belong to the activity company;
  external participants are valid. When both activity and deal have a company, their company IDs
  must match. An activity company plus a company-less deal is valid; the activity does not mutate
  the deal.
- An activity is written once; join rows make it discoverable from every linked record.
- This is historical logging, not scheduling. Future `occurredAt` is rejected beyond five minutes of
  clock skew.

### 4.5 Follow-ups and action stream

A `FollowUp` belongs to one contact, is assigned to one user, and has type
`asap|date|waiting|queued`, text (1–140), optional due date, position, completion metadata, and
version. A contact has at most one open ASAP follow-up per assignee. Creating another demotes the
prior one to dated today atomically.

The Action Stream merges:

- each contact's highest-priority open follow-up for the current assignee; and
- pending deals owned by the actor with due/overdue deal next actions.

Order: ASAP → overdue date → today → future → waiting → queued, then stable ID. Deal actions use the
same date weighting but never displace an ASAP contact action. Each result identifies
`kind: 'contact-follow-up'|'deal-next-action'`.

## 5. D1 schema

Tables are STRICT with foreign keys inside CRM_DB:

- `companies` with indexes on `name_normalized`, `(deleted_at, name_normalized)`.
- `contacts` with indexes on `company_id`, `owner_id`, normalized names/email, deletion.
- `tags(id, key UNIQUE, display_name)` and `contact_tags(contact_id, tag_id)`.
- `pipelines`, `pipeline_stages` with unique `(pipeline_id, key)` and `(pipeline_id, position)`.
- `deals`; indexes `(owner_id,status,next_action_date)`, `(pipeline_id,stage_id,status)`,
  `primary_contact_id`, `company_id`, unique partial `project_id` when non-null.
- `activities`; indexes `(occurred_at DESC,id)`, `author_id`, `company_id`, `deal_id`.
- `activity_contacts(activity_id,contact_id, PRIMARY KEY(...))`; reverse contact index.
- `follow_ups`; indexes for action-stream query by assignee/completion/type/date and contact.
- `audit_events`, `idempotency_records` per system spec.

Search across contacts/companies/deals uses indexed normalized columns and prefix matching in
release one, not a cross-service FTS index.

## 6. Authorization

- `crm.read`: contact/company/deal/activity/follow-up reads and Action Stream.
- `report.read`: `getPipelineSummary` only.
- `audit.read`: `listAudit` only.
- Create/update/activity/follow-up: `crm.write`.
- Deletes: `crm.delete`.
- Conversion snapshot/backlink: `deal.convert`.
- Service calls Permissions before repository reads that could reveal existence.
- Owners/managers can query all. Release-one sales visibility is installation-wide; ownership drives
  responsibility/filtering, not row-level secrecy. Private contacts are Could-have and excluded from
  this specification until separately approved.

## 7. Transactions, idempotency, and deletion

Single-aggregate writes, join changes, primary-contact reassignment, audit, and idempotency result
are one D1 transaction/batch. Contact soft deletion is rejected while it is a deal primary contact;
the user must reassign or close/delete the deal. Activity links to a deleted contact remain for
history and hydrate as tombstones.

Conversion operations use unique deal/project links and the system saga. A Notes outage never rolls
back CRM changes. No background promise is used for correctness-critical work.

## 8. Test strategy

### Unit

Validation lengths/formats, company reuse ambiguity, deterministic primary reassignment, deal state
machine, contact/deal/company consistency, activity multi-links, action weights, pipeline totals,
optimistic concurrency.

### Application with fakes

Inject `PermissionsPort`, repositories, clock, and ID generator. Test every permission, fail-closed
outage, idempotency, audit rollback, conversion replay, and deletion preconditions.

### D1 adapter

Apply CRM migrations. Test constraints/index-supported queries, primary reassignment transaction,
activity joins from each direction, action-stream ordering, report aggregation, soft-delete filters,
and cursor stability under equal dates.

### Contract and integration

- `crmContractTests` runs against real service and `FakeCrmService` used by API/Projects/MCP/Notes.
- Real CRM + fake Permissions covers allow/deny/outage/malformed decision.
- Real CRM + real Permissions proves role behavior.
- System tests convert a won deal, retry backlink, and create a multi-contact activity discoverable
  from each target.

## 9. Acceptance criteria

- One activity linked to N contacts has one canonical ID/row and N join rows.
- Deleting a primary company contact never leaves a dangling pointer.
- Deal and company primary contacts remain independent.
- Action stream merges contact and deal actions deterministically.
- No CRM operation or label lookup requires Notes or Projects availability.
- All inputs and outputs satisfy the shared RPC contract and bounded pagination.

## 10. Open questions

1. Must an activity have at least one contact, or should company-only calls be valid? Current
   decision: at least one contact.
2. Should a contact support multiple companies? Current decision: one company in release one.
3. Should ambiguous normalized company names force explicit selection (current decision) or create a
   duplicate automatically?
4. Confirm initial pipeline stages and whether owners need stage administration in release one.
5. Confirm installation currency default (`GBP` proposed) and whether amount may be unknown/null.
6. Should losing/winning a deal preserve its last next action as history in a separate event table?
   Current decision: the audit snapshot preserves it.
7. Is automatic primary-contact reassignment to the oldest remaining contact the desired rule, or
   should deletion require an explicit replacement when alternatives exist?
