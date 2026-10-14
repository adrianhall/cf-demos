import { TOOL_CATALOGUE, type AgentToolDefinition } from '../../shared/agent/catalogue.ts';
/**
 * Runtime registry for the shared read-only agent catalogue.
 */
import type { DataService, ActorContext } from '../../shared/data-service/contract.ts';

/**
 * Context supplied by a verified transport.
 */
export interface AgentToolContext {
  /**
   * Authoritative Data Worker client.
   */
  readonly data: DataService;
  /**
   * Verified actor, including the transport channel.
   */
  readonly actor: ActorContext;
}

/**
 * Runtime tool entry with a narrow DataService delegation.
 */
export interface AgentTool extends AgentToolDefinition {
  /**
   * Execute with verified identity and validated input.
   */
  execute(context: AgentToolContext, input: unknown): Promise<unknown>;
}

/**
 * Build the runtime registry. Transport-specific adapters can use the same definitions and names.
 *
 * @param definitions Catalogue definitions.
 * @returns Runtime tools.
 */
export function createAgentTools(
  definitions: readonly AgentToolDefinition[] = TOOL_CATALOGUE
): AgentTool[] {
  return definitions.map((definition) => ({
    ...definition,
    execute: async ({ data, actor }, input) => {
      const values = input as Record<string, unknown>;
      const mutationInput = Object.fromEntries(
        Object.entries(values).filter(
          ([key]) => !['idempotencyKey', 'id', 'expectedVersion'].includes(key)
        )
      );
      const without = (...keys: string[]): Record<string, unknown> =>
        Object.fromEntries(Object.entries(mutationInput).filter(([key]) => !keys.includes(key)));
      switch (definition.name) {
        case 'whoami':
          return data.permissions.getSession(actor);
        case 'search_customers':
          return {
            contacts: await data.crm.listContacts(actor, values as never),
            companies: await data.crm.listCompanies(actor, values as never)
          };
        case 'get_contact':
          return data.crm.getContact(actor, String(values.id));
        case 'get_company':
          return data.crm.getCompany(actor, String(values.id));
        case 'list_deals':
          return data.crm.listDeals(actor, values as never);
        case 'get_deal':
          return data.crm.getDeal(actor, String(values.id));
        case 'action_stream':
          return data.crm.actionStream(actor);
        case 'pipeline_summary':
          return data.crm.pipelineSummary(actor);
        case 'quarterly_pipeline':
          return data.crm.quarterlyPipeline(actor, values as never);
        case 'list_projects':
          return data.projects.listProjects(actor, values as never);
        case 'get_project':
          return data.projects.getProject(actor, String(values.id));
        case 'my_work':
          return data.projects.myWork(actor);
        case 'search_notes':
          return data.notes.searchNotes(actor, String(values.text));
        case 'get_note':
          return data.notes.getNote(actor, String(values.id));
        case 'delivery_report':
          return data.projects.deliveryReport(actor, values as never);
        case 'create_contact':
          return data.crm.createContact(actor, mutationInput as never, {
            idempotencyKey: String(values.idempotencyKey)
          });
        case 'update_contact':
          return data.crm.updateContact(
            actor,
            String(values.id),
            mutationInput as never,
            Number(values.expectedVersion),
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        case 'update_company':
          return data.crm.updateCompany(
            actor,
            String(values.id),
            mutationInput as never,
            Number(values.expectedVersion),
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        case 'create_deal':
          return data.crm.createDeal(actor, mutationInput as never, {
            idempotencyKey: String(values.idempotencyKey)
          });
        case 'update_deal':
          return data.crm.updateDeal(
            actor,
            String(values.id),
            mutationInput as never,
            Number(values.expectedVersion),
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        case 'set_deal_outcome':
          return data.crm.updateDeal(
            actor,
            String(values.id),
            { status: values.status } as never,
            Number(values.expectedVersion),
            { idempotencyKey: String(values.idempotencyKey) }
          );
        case 'log_activity':
          return data.crm.createActivity(actor, mutationInput as never, {
            idempotencyKey: String(values.idempotencyKey)
          });
        case 'set_next_action':
          return data.crm.setContactNextAction(
            actor,
            String(values.contactId),
            without('contactId') as never,
            Number(values.expectedVersion),
            { idempotencyKey: String(values.idempotencyKey) }
          );
        case 'complete_next_action':
          return data.crm.completeContactNextAction(
            actor,
            String(values.contactId),
            Number(values.expectedVersion),
            { idempotencyKey: String(values.idempotencyKey) }
          );
        case 'convert_deal':
          return data.projects.convertDeal(
            actor,
            String(values.dealId),
            without('dealId') as never,
            Number(values.expectedVersion),
            { idempotencyKey: String(values.idempotencyKey) }
          );
        case 'create_task':
          return data.projects.createTask(
            actor,
            String(values.projectId),
            without('projectId') as never,
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        case 'update_task':
          return data.projects.updateTask(
            actor,
            String(values.id),
            mutationInput as never,
            Number(values.expectedVersion),
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        case 'create_note':
          return data.notes.createNote(actor, mutationInput as never, {
            idempotencyKey: String(values.idempotencyKey)
          });
        case 'update_note':
          return data.notes.updateNote(
            actor,
            String(values.id),
            mutationInput as never,
            Number(values.expectedVersion),
            {
              idempotencyKey: String(values.idempotencyKey)
            }
          );
        default:
          throw new Error(`Unknown agent tool: ${definition.name}`);
      }
    }
  }));
}
