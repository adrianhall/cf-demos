/**
 * @file The tool catalogue the public MCP guide page shows a reader, grouped by what each tool
 *   does. Split out of `./McpGuideView.tsx` rather than declared inside it so it can be imported
 *   without JSX, which is what lets the Workers-runtime suite check it against a real `tools/list`
 *   response from the deployed handler. A page that advertised a tool the server does not register,
 *   or omitted one it does, would be worse than no page — and a guide is exactly the kind of file
 *   that rots quietly, because nothing fails when it goes stale.
 */

/**
 * One group of the tool catalogue.
 */
export interface ToolGroup {
  /**
   * What the tools in this group do, as a reader would describe it.
   */
  title: string;
  /**
   * Tool names exactly as `src/worker/mcp/server.ts` registers them.
   */
  tools: string[];
  /**
   * What a reader should know about the group before connecting.
   */
  note: string;
}

/**
 * The registered tools, grouped by what they do.
 *
 * Pinned against the handler's own `tools/list` output by `tests/integration/mcp.test.ts`, so
 * adding a tool to the server without listing it here fails the suite.
 */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    title: 'Reading',
    tools: ['list_diagrams', 'get_diagram'],
    note: 'Your own diagrams only. A diagram belonging to somebody else is reported exactly like one that does not exist.'
  },
  {
    title: 'Creating and managing',
    tools: ['create_diagram', 'rename_diagram', 'delete_diagram'],
    note: 'A new diagram is always owned by you. Deleting one also revokes any share link pointing at it, and cannot be undone.'
  },
  {
    title: 'Editing the canvas',
    tools: [
      'add_node',
      'update_node',
      'remove_node',
      'add_edge',
      'update_edge',
      'remove_edge',
      'auto_layout_diagram'
    ],
    note: 'Every change is saved immediately and pushed to any editor tab you have open on that diagram. The server-side auto-layout is a simple grid tidy-up; the editor\u2019s own Auto layout button runs a proper layered engine in the browser.'
  },
  {
    title: 'Sharing',
    tools: ['create_share_link', 'get_share_status', 'revoke_share_link'],
    note: 'Only a hash of a link is stored, so the URL is returned exactly once when it is minted and genuinely cannot be shown again. Lost a link? Mint a new one, which revokes the old.'
  },
  {
    title: 'Exporting',
    tools: ['export_diagram'],
    note: 'json, svg or scaffold. SVG is a standalone vector image generated from the stored graph; PNG remains browser-only.'
  }
];

/**
 * Every tool name the guide page advertises, flattened across its groups.
 *
 * @returns The advertised tool names, in the order the page presents them.
 */
export function advertisedToolNames(): string[] {
  return TOOL_GROUPS.flatMap((group) => group.tools);
}
