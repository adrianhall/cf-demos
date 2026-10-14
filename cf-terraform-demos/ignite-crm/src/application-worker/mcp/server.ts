import { createMcpHandler } from 'agents/mcp/server';
import * as v from 'valibot';
/**
 * Stateless MCP server factory over the verified Application Worker request context.
 *
 * The server is created per request, so neither Access identity nor Data Worker client state can
 * leak from one MCP caller to another. The Data Worker remains the authority for every tool call.
 */
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { toJsonSchema } from '@valibot/to-json-schema';
import { isServiceError } from '../../shared/common/errors.ts';
import type { ActorContext, DataService } from '../../shared/data-service/contract.ts';
import { type Permission, PermissionSchema } from '../../shared/permissions.ts';
import { presentToolError } from '../agent/errors.ts';
import { createAgentTools, type AgentToolContext } from '../agent/tools.ts';

/**
 * Inputs verified by middleware before an MCP server is made.
 */
export interface McpRequestContext {
  /**
   * Authoritative data-service client scoped to this request.
   */
  readonly data: DataService;
  /**
   * The authenticated caller, explicitly stamped as MCP.
   */
  readonly actor: ActorContext;
  /**
   * Current caller capabilities from the Data Worker.
   */
  readonly permissions: readonly string[];
}

/**
 * Convert a tool outcome to MCP content without exposing raw service failures.
 *
 * @param value Tool result.
 * @returns MCP tool content.
 */
function jsonContent(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Add the JSON-Schema conversion protocol that MCP SDK v2 requires to a Valibot schema.
 *
 * @param schema Valibot input schema.
 * @returns Standard Schema validator with JSON Schema conversion.
 */
function mcpInputSchema(schema: v.GenericSchema): StandardSchemaWithJSON {
  const standard = schema as unknown as StandardSchemaWithJSON;
  Object.defineProperty(standard['~standard'], 'jsonSchema', {
    configurable: true,
    value: {
      // Valibot actions such as `minValue` have no JSON Schema equivalent. MCP still validates the
      // full Valibot schema at execution; omission here affects descriptions, not enforcement.
      input: () => toJsonSchema(schema, { errorMode: 'ignore' }),
      output: () => toJsonSchema(schema, { errorMode: 'ignore' })
    }
  });
  return standard;
}

/**
 * Register the tools a caller may use on their isolated server instance.
 *
 * @param context Authenticated request context.
 * @returns A newly configured SDK v2 MCP server.
 */
export function createCrmMcpServer(context: McpRequestContext): McpServer {
  const server = new McpServer({ name: 'ignite-crm', version: '1.0.0' });
  const toolContext: AgentToolContext = { data: context.data, actor: context.actor };
  const capabilities = context.permissions.filter((permission): permission is Permission =>
    v.is(PermissionSchema, permission)
  );
  const permitted = createAgentTools().filter((tool) =>
    tool.requires.every((permission) => capabilities.includes(permission))
  );

  for (const tool of permitted) {
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: mcpInputSchema(tool.input)
      },
      async (input: unknown) => {
        const parsed = v.safeParse(tool.input, input);
        if (!parsed.success) {
          return jsonContent({
            error: { code: 'VALIDATION_FAILED', message: 'Tool arguments are invalid.' }
          });
        }
        try {
          return jsonContent(await tool.execute(toolContext, parsed.output));
        } catch (error) {
          if (isServiceError(error)) {
            return jsonContent({ error: presentToolError(error) });
          }
          return jsonContent({
            error: { code: 'INTERNAL', message: 'The tool could not be completed.' }
          });
        }
      }
    );
  }
  return server;
}

/**
 * Create the stateless Streamable HTTP handler for one verified request.
 *
 * @param context Authenticated request context.
 * @param hostname Accepted endpoint hostname.
 * @returns A handler for the exact `/mcp` route.
 */
export function createCrmMcpHandler(context: McpRequestContext, hostname: string) {
  return createMcpHandler(() => createCrmMcpServer(context), {
    route: '/mcp',
    corsOptions: false,
    allowedHostnames: [hostname],
    allowedOriginHostnames: [hostname],
    legacy: 'reject',
    responseMode: 'json'
  });
}
