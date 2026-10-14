/**
 * Capability-based visibility for the shared agent catalogue.
 */
import type { AgentToolDefinition } from '../../shared/agent/catalogue.ts';
import type { Permission } from '../../shared/permissions.ts';

/**
 * Filter tools before they are shown to a model. The Data Worker remains authoritative at
 * execution.
 *
 * @param tools Published tool definitions.
 * @param capabilities Permissions from the caller's current session.
 * @returns Tools whose requirements are all held by the caller.
 */
export function permittedTools(
  tools: readonly AgentToolDefinition[],
  capabilities: readonly Permission[]
): AgentToolDefinition[] {
  return tools.filter((tool) =>
    tool.requires.every((permission) => capabilities.includes(permission))
  );
}
