import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  createDiagramTool,
  deleteDiagramTool,
  getDiagramTool,
  listDiagramsTool,
  type McpToolContext,
  renameDiagramTool
} from './tools.ts';

/**
 * @file The protocol surface of the remote MCP endpoint: tool names, schemas, descriptions, and the
 *   one handler that serves them. Everything a tool actually _does_ lives in `./tools.ts`, over the
 *   same application services the HTTP routes use.
 */

/**
 * Name this server reports to a client during negotiation.
 */
const SERVER_NAME = 'architect-mcp';

/**
 * Version this server reports to a client.
 *
 * The tool catalogue's own version, not the demo's: a client caches a tool list against it, so it
 * should move when a tool's name, schema or meaning changes and stay put when the Worker is merely
 * redeployed.
 */
const SERVER_VERSION = '1.0.0';

/**
 * Pathname the handler serves.
 *
 * The handler matches this exactly and answers `404` for anything else, so the Hono route that
 * mounts it must use the identical literal — see `../routes/mcp.ts`. It is also the prefix
 * `src/access-policies.ts` authenticates and `cloudflare.config.ts` lists in `runWorkerFirst`;
 * those three agreeing is what makes a tool call reach authenticated Worker code at all.
 */
export const MCP_ROUTE = '/mcp';

/**
 * Describes a diagram id argument, shared by every tool that takes one.
 *
 * One definition rather than four, so a model sees the same wording wherever it appears and the
 * description cannot drift between tools that mean the same thing.
 */
const diagramIdSchema = z
  .string()
  .describe('The diagram\u2019s id, as returned by list_diagrams or create_diagram.');

/**
 * The sentence appended to every tool description that touches a single diagram.
 *
 * Stated on each tool rather than once in the server's own metadata because a calling model sees
 * tool descriptions in isolation — it is given a catalogue of tools, not a document about the
 * server. Saying it plainly is what stops a model inferring the security model from behaviour, for
 * example by concluding from a `404` that a diagram was deleted when it is simply somebody else's.
 */
const OWNER_SCOPED =
  'Only ever acts on a diagram owned by the authenticated caller. A diagram id belonging to '
  + 'someone else is reported exactly like one that does not exist.';

/**
 * Builds the MCP server for one request, with every tool closed over that caller's identity.
 *
 * This is the factory `createMcpHandler` invokes, and the per-request scoping of identity rests
 * entirely on it being a factory: the handler calls it once per request, so a tool closure can
 * never outlive the caller it was built for. Nothing identity-shaped is stored on the handler
 * itself, which is why the handler below can safely be a module-scope singleton even though a
 * Worker isolate serves many callers.
 *
 * The caller's identity is **not** taken from the SDK's `authInfo`. Cloudflare Access resolves an
 * MCP client's opaque OAuth token at the edge and forwards a signed `Cf-Access-Jwt-Assertion`
 * header, so from this Worker's point of view the request is indistinguishable from a
 * browser-authenticated one and there is no bearer token to inspect. The identity therefore arrives
 * the same way it does on every other route — verified by the Access middleware — and is handed to
 * this factory already resolved.
 *
 * No handler here needs a `try`/`catch`. The MCP SDK's `tools/call` dispatcher converts a thrown
 * error's message into `{ content: [...], isError: true }`, which is the protocol's own way of
 * reporting a failed tool call, so a `notFound()` from the application tier surfaces to the model
 * as the same "Diagram not found." it would see over HTTP.
 *
 * @param context Resolved per-request context: the verified identity, the diagram service and the
 *   request-scoped logger.
 * @returns A server instance carrying this caller's tools and resources, ready for the handler to
 *   connect to a transport. It is never connected directly by this file.
 */
export function createMcpServer(context: McpToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'list_diagrams',
    {
      title: 'List diagrams',
      description:
        'List every diagram owned by the authenticated caller, most recently updated first. '
        + 'Returns each diagram\u2019s id, title, description and timestamps but not its graph \u2014 '
        + 'call get_diagram for that. Only ever lists diagrams owned by the authenticated caller.'
    },
    async () => {
      const { diagrams } = await listDiagramsTool(context);

      return { content: [{ text: JSON.stringify(diagrams), type: 'text' }] };
    }
  );

  server.registerTool(
    'get_diagram',
    {
      title: 'Get diagram',
      description:
        'Read one diagram\u2019s metadata and its full graph (nodes, edges and viewport, as a '
        + `JSON string in graphData). ${OWNER_SCOPED}`,
      inputSchema: z.object({ diagramId: diagramIdSchema })
    },
    async ({ diagramId }) => {
      const { diagram } = await getDiagramTool(context, diagramId);

      return { content: [{ text: JSON.stringify(diagram), type: 'text' }] };
    }
  );

  // The same read, also exposed as a resource. A tool call is a model deciding to act; a resource
  // is a client attaching material as context, which is what reading a diagram usually is. The
  // two share `getDiagramTool` deliberately — a resource that resolved ownership its own way
  // would be a second place for the rule to go wrong.
  //
  // `list: undefined` is required by `ResourceTemplate`'s constructor even though this template
  // is never enumerated. Enumerating it would mean listing every diagram id the caller owns as a
  // resource catalogue, which `list_diagrams` already does in a form a model can actually read.
  server.registerResource(
    'diagram',
    new ResourceTemplate('architect://diagrams/{id}', { list: undefined }),
    {
      title: 'Diagram',
      description: `A diagram\u2019s metadata and graph as JSON. ${OWNER_SCOPED}`,
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      // `{id}` has no explode modifier, so this template can only ever match a single value. The
      // SDK's `Variables` type is a `string | string[]` union covering every possible template
      // shape rather than a real possibility for this one, so the array case is normalised here
      // instead of being asserted away.
      const raw = variables.id;
      const id = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      const { diagram } = await getDiagramTool(context, id);

      return {
        contents: [{ mimeType: 'application/json', text: JSON.stringify(diagram), uri: uri.href }]
      };
    }
  );

  server.registerTool(
    'create_diagram',
    {
      title: 'Create diagram',
      description:
        'Create a new, empty diagram owned by the authenticated caller, or seed it from a '
        + 'blueprint template. The new diagram is always owned by the authenticated caller; there '
        + 'is no way to create one on somebody else\u2019s behalf.',
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .describe('Diagram title. Defaults to "Untitled Diagram" when omitted.'),
        description: z
          .string()
          .nullable()
          .optional()
          .describe('Optional free-text description of what the diagram shows.'),
        blueprintId: z
          .string()
          .optional()
          .describe(
            'Slug of a blueprint template whose graph seeds the new diagram. Omit for an empty '
              + 'canvas. An unknown slug is rejected and nothing is created.'
          )
      })
    },
    async (input) => {
      const diagram = await createDiagramTool(context, input);

      return { content: [{ text: JSON.stringify(diagram), type: 'text' }] };
    }
  );

  server.registerTool(
    'rename_diagram',
    {
      title: 'Rename diagram',
      description:
        'Change a diagram\u2019s title and/or description. Supply at least one of them; sending '
        + `neither is an error rather than a no-op. ${OWNER_SCOPED}`,
      inputSchema: z.object({
        diagramId: diagramIdSchema,
        title: z.string().optional().describe('New title. Omit to leave the title unchanged.'),
        description: z
          .string()
          .nullable()
          .optional()
          .describe(
            'New description. Send null to clear it; omit the field entirely to leave it '
              + 'unchanged. The two are different.'
          )
      })
    },
    async ({ diagramId, ...input }) => {
      const diagram = await renameDiagramTool(context, diagramId, input);

      return { content: [{ text: JSON.stringify(diagram), type: 'text' }] };
    }
  );

  server.registerTool(
    'delete_diagram',
    {
      title: 'Delete diagram',
      description:
        'Permanently delete a diagram and revoke any read-only share link pointing at it. This '
        + `cannot be undone and there is no recycle bin. ${OWNER_SCOPED}`,
      inputSchema: z.object({ diagramId: diagramIdSchema })
    },
    async ({ diagramId }) => {
      await deleteDiagramTool(context, diagramId);

      return { content: [{ text: `Diagram ${diagramId} deleted.`, type: 'text' }] };
    }
  );

  return server;
}

/**
 * Creates the stateless MCP handler for one hostname.
 *
 * Stateless is right here on its own merits rather than by default: every tool's state is a D1 row,
 * so nothing needs to survive between two MCP requests, and a session identifier would be a second
 * place for durable data to hide.
 *
 * `allowedHostnames` has to be supplied because the handler performs its own `Host` validation and
 * its default allowlist covers only localhost and `workers.dev` — a custom domain is not in it, so
 * leaving the default would answer every deployed request with a `403` that looks like an Access
 * failure. The value comes from the Terraform `hostname` output through the `PUBLIC_HOSTNAME`
 * binding; it is never written as a literal, because this demo is deployed alongside the
 * implementation it was ported from and a stale hostname here could point at it.
 *
 * Localhost is admitted alongside the configured hostname so `pnpm start` works without a
 * development-only branch. That is not a weakening: it widens the `Host` header allowlist, which is
 * a DNS-rebinding defence, and says nothing about authorization — the Access middleware still runs
 * in front of this handler in local development exactly as it does in production.
 *
 * @param hostname Public hostname this Worker serves, from the `PUBLIC_HOSTNAME` binding.
 * @param buildContext Resolves the per-request tool context from the request the handler is
 *   serving. Called once per request, inside the server factory, so the identity it returns is
 *   scoped to that one caller.
 * @returns A handler whose `fetch` serves one MCP request and resolves with the response.
 * @throws {Error} At request time, propagated from `buildContext`, when the request reached the
 *   handler without a verified Access identity — which would mean the handler had been mounted
 *   without the Access middleware in front of it.
 */
export function createArchitectMcpHandler(
  hostname: string,
  buildContext: (request: Request) => McpToolContext
): { fetch: (request: Request) => Promise<Response> } {
  return createMcpHandler(
    (requestContext) => {
      // `requestInfo` is set on every HTTP invocation of this handler, on both protocol eras.
      // Its absence would mean the factory had been reached some other way — a stdio connection,
      // which this Worker has no route to — and a tool built without an identity must never run.
      if (requestContext.requestInfo === undefined) {
        throw new Error('The MCP server factory was invoked without an HTTP request.');
      }

      return createMcpServer(buildContext(requestContext.requestInfo));
    },
    {
      route: MCP_ROUTE,
      allowedHostnames: [hostname, 'localhost', '127.0.0.1', '[::1]']
    }
  );
}
