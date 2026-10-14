/**
 * Shared AI tool catalogue. Transport adapters consume this catalogue so chat and MCP cannot drift.
 * Inputs deliberately use strict objects: identity is always supplied by the verified request.
 */
import * as v from 'valibot';
import {
  CreateContactInputSchema,
  UpdateContactInputSchema,
  UpdateCompanyInputSchema
} from '../api/crm.ts';
import { CreateNoteInputSchema, UpdateNoteInputSchema } from '../api/notes.ts';
import {
  ConvertDealInputSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema
} from '../api/projects.ts';
import {
  CreateActivityInputSchema,
  CreateDealInputSchema,
  SetNextActionInputSchema,
  UpdateDealInputSchema
} from '../api/sales.ts';
import { IdSchema } from '../common/ids.ts';
import { PermissionSchema, type Permission } from '../permissions.ts';

/**
 * A bounded agent list size.
 */
export const AgentLimitSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  20
);

/**
 * Base input shared by tools which accept a search term and paging.
 */
export const SearchInputSchema = v.strictObject({
  q: v.optional(v.pipe(v.string(), v.maxLength(200))),
  limit: AgentLimitSchema,
  cursor: v.optional(v.string())
});

/**
 * A simple identifier input.
 */
export const IdInputSchema = v.strictObject({ id: IdSchema });

/**
 * Tool metadata shared by every composition surface.
 */
export interface AgentToolDefinition {
  /**
   * Stable protocol name.
   */
  readonly name: string;
  /**
   * Human-readable title.
   */
  readonly title: string;
  /**
   * Grounding and domain guidance shown to models.
   */
  readonly description: string;
  /**
   * Capabilities required before the tool is offered.
   */
  readonly requires: readonly Permission[];
  /**
   * Whether execution changes CRM state.
   */
  readonly mutates: boolean;
  /**
   * Standard-schema input validator.
   */
  readonly input: v.GenericSchema;
}

const read = (
  name: string,
  title: string,
  description: string,
  requires: readonly Permission[],
  input: v.GenericSchema
): AgentToolDefinition => ({
  name,
  title,
  description,
  requires,
  input,
  mutates: false
});

/**
 * Metadata required for every agent mutation.
 */
const MutationInputSchema = v.strictObject({
  idempotencyKey: v.pipe(v.string(), v.minLength(1), v.maxLength(200))
});

/**
 * Field names that would mean "act as somebody else". A tool never accepts one: the actor comes
 * only from the verified request (§4.3), so a model that invents one gets a validation error rather
 * than silent acceptance.
 *
 * `email` is deliberately **absent**, and that is a correctness point rather than an oversight: a
 * contact's e-mail address is domain data that `create_contact` and `update_contact` legitimately
 * carry. Banning the word would make those tools uncallable while protecting nothing, because the
 * domain schemas below are strict objects — an `email` that is not part of the domain body is
 * already rejected by them. The guard exists for the names that are _never_ part of any body.
 */
const ACTOR_FIELDS = ['actor', 'actorId', 'userId', 'role', 'roles', 'permissions'] as const;

/**
 * Validate mutation metadata and the strict domain body without allowing actor fields.
 *
 * @param schema The domain body's schema.
 * @param requireVersion Whether the tool is an update, which must carry `id` and `expectedVersion`
 *   so a concurrent change becomes a conflict rather than a silent overwrite.
 * @returns A schema for the whole tool input: metadata plus the domain body.
 */
const mutationEnvelope = (schema: v.GenericSchema, requireVersion: boolean): v.GenericSchema =>
  v.pipe(
    v.record(v.string(), v.unknown()),
    v.check(
      (input) => typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0,
      'Every change needs an idempotency key.'
    ),
    v.check(
      (input) =>
        !requireVersion
        || (typeof input.id === 'string'
          && typeof input.expectedVersion === 'number'
          && Number.isInteger(input.expectedVersion)),
      'An update needs the record id and the version it was read at.'
    ),
    v.check(
      (input) => ACTOR_FIELDS.every((field) => !(field in input)),
      'A tool never chooses who it acts as.'
    ),
    v.check((input) => {
      const body = { ...input };
      delete body.idempotencyKey;
      delete body.id;
      delete body.expectedVersion;
      return v.safeParse(schema, body).success;
    }, 'The arguments do not match this tool’s schema.')
  );

/**
 * Add an identifier and optimistic-concurrency version to a mutation schema.
 */
const updateInput = (schema: v.GenericSchema): v.GenericSchema => mutationEnvelope(schema, true);

/**
 * Add only idempotency metadata to a create mutation schema.
 */
const createInput = (schema: v.GenericSchema): v.GenericSchema => mutationEnvelope(schema, false);

const write = (
  name: string,
  title: string,
  description: string,
  requires: readonly Permission[],
  input: v.GenericSchema
): AgentToolDefinition => ({
  name,
  title,
  description,
  requires,
  input,
  mutates: true
});

/**
 * The read-only tools in the first release.
 */
export const READ_TOOL_CATALOGUE: readonly AgentToolDefinition[] = [
  read(
    'whoami',
    'Who am I?',
    'Return the verified caller display name, roles, and capabilities. Never return tokens.',
    [],
    v.strictObject({})
  ),
  read(
    'search_customers',
    'Search customers',
    'Search contacts and companies by name or email. Results are bounded and permission-filtered.',
    ['crm.read'],
    SearchInputSchema
  ),
  read(
    'get_contact',
    'Get contact',
    'Read one contact and its bounded customer timeline.',
    ['crm.read'],
    IdInputSchema
  ),
  read(
    'get_company',
    'Get company',
    'Read one company, contacts, and open deals.',
    ['crm.read'],
    IdInputSchema
  ),
  read(
    'list_deals',
    'List deals',
    'List bounded deals. Stages are fixed pipeline stages; status is not a stage.',
    ['crm.read'],
    SearchInputSchema
  ),
  read(
    'get_deal',
    'Get deal',
    'Read one deal, stage history, and activity.',
    ['crm.read'],
    IdInputSchema
  ),
  read(
    'action_stream',
    'Action stream',
    'Return the caller’s own follow-up queue.',
    ['crm.read'],
    v.strictObject({})
  ),
  read(
    'pipeline_summary',
    'Pipeline summary',
    'Return counts and value by fixed stage and the current-quarter total.',
    ['report.read'],
    v.strictObject({})
  ),
  read(
    'quarterly_pipeline',
    'Quarterly pipeline',
    'Return open deals for one calendar quarter grouped by fixed stage.',
    ['report.read'],
    v.strictObject({ quarter: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-Q[1-4]$/u))) })
  ),
  read(
    'list_projects',
    'List projects',
    'List active projects with bounded results.',
    ['project.read'],
    SearchInputSchema
  ),
  read(
    'get_project',
    'Get project',
    'Read one project with a bounded task list.',
    ['project.read'],
    IdInputSchema
  ),
  read(
    'my_work',
    'My work',
    'Return tasks assigned to the verified caller.',
    ['project.read'],
    v.strictObject({})
  ),
  read(
    'search_notes',
    'Search notes',
    'Search notes the caller may read. Notes are separate linked documents, not contact fields.',
    ['note.read'],
    v.strictObject({ text: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })
  ),
  read(
    'get_note',
    'Get note',
    'Read one note and its validated record links.',
    ['note.read'],
    IdInputSchema
  ),
  read(
    'delivery_report',
    'Delivery report',
    'Return bounded task counts by status across active projects.',
    ['report.read'],
    v.strictObject({})
  )
] as const;

/**
 * All currently published catalogue tools.
 */
/**
 * Mutating tools, all requiring explicit approval in the chat transport.
 */
export const WRITE_TOOL_CATALOGUE: readonly AgentToolDefinition[] = [
  write(
    'create_contact',
    'Create contact',
    'Create a CRM contact and optionally reuse or create its company.',
    ['crm.write'],
    createInput(CreateContactInputSchema)
  ),
  write(
    'update_contact',
    'Update contact',
    'Update a contact using optimistic concurrency.',
    ['crm.write'],
    updateInput(UpdateContactInputSchema)
  ),
  write(
    'update_company',
    'Update company',
    'Update a company using optimistic concurrency.',
    ['crm.write'],
    updateInput(UpdateCompanyInputSchema)
  ),
  write(
    'create_deal',
    'Create deal',
    'Create a deal on an existing customer record.',
    ['crm.write'],
    createInput(CreateDealInputSchema)
  ),
  write(
    'update_deal',
    'Update deal',
    'Update a deal using optimistic concurrency.',
    ['crm.write'],
    updateInput(UpdateDealInputSchema)
  ),
  write(
    'set_deal_outcome',
    'Set deal outcome',
    'Mark a deal won or lost using optimistic concurrency.',
    ['crm.write'],
    updateInput(v.strictObject({ status: v.picklist(['won', 'lost']) }))
  ),
  write(
    'log_activity',
    'Log activity',
    'Log a call or meeting against CRM records.',
    ['crm.write'],
    createInput(CreateActivityInputSchema)
  ),
  write(
    'set_next_action',
    'Set next action',
    'Set or replace a contact follow-up using optimistic concurrency.',
    ['crm.write'],
    v.intersect([
      MutationInputSchema,
      v.strictObject({
        contactId: IdSchema,
        expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1))
      }),
      SetNextActionInputSchema
    ])
  ),
  write(
    'complete_next_action',
    'Complete next action',
    'Complete a contact follow-up using optimistic concurrency.',
    ['crm.write'],
    v.intersect([
      MutationInputSchema,
      v.strictObject({
        contactId: IdSchema,
        expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1))
      })
    ])
  ),
  write(
    'convert_deal',
    'Convert deal',
    'Convert a won deal into a delivery project.',
    ['deal.convert'],
    v.intersect([
      MutationInputSchema,
      v.strictObject({
        dealId: IdSchema,
        expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1))
      }),
      ConvertDealInputSchema
    ])
  ),
  write(
    'create_task',
    'Create task',
    'Create a task on an active project.',
    ['project.write'],
    v.intersect([
      MutationInputSchema,
      v.strictObject({ projectId: IdSchema }),
      CreateTaskInputSchema
    ])
  ),
  write(
    'update_task',
    'Update task',
    'Update a task using optimistic concurrency.',
    ['project.write'],
    updateInput(UpdateTaskInputSchema)
  ),
  write(
    'create_note',
    'Create note',
    'Create a Markdown note linked to CRM records.',
    ['note.write'],
    createInput(CreateNoteInputSchema)
  ),
  write(
    'update_note',
    'Update note',
    'Update a note using optimistic concurrency.',
    ['note.write'],
    updateInput(UpdateNoteInputSchema)
  )
] as const;

/**
 * All tools exposed over MCP and chat.
 */
export const TOOL_CATALOGUE = [...READ_TOOL_CATALOGUE, ...WRITE_TOOL_CATALOGUE] as const;

/**
 * Assert a catalogue permission at module boundaries.
 */
export function isPermission(value: string): value is Permission {
  return v.is(PermissionSchema, value);
}

/**
 * Names are the parity contract between chat and MCP.
 */
export const TOOL_NAMES = TOOL_CATALOGUE.map((tool) => tool.name);
