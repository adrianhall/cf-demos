/**
 * @file The one vocabulary every structured log event in this Worker uses to say which surface
 *   performed a change. Two transports now reach the same use cases — the browser's HTTP API and
 *   the remote MCP endpoint — and an operator reading Workers Logs needs to tell an agent's edit
 *   apart from a person's without a second event name or a second table.
 */

/**
 * Which transport a logged change arrived through.
 *
 * Written as one shared type rather than a string literal at each call site so the two spellings
 * cannot drift: a log pipeline filtering on `via` breaks silently if one route starts emitting
 * `"API"` or `"mcp-tool"`, and a silent break in observability is only discovered when somebody
 * needs the data.
 *
 * - `api` — an HTTP request to `/api/*`, which in practice means the browser client.
 * - `mcp` — a tool call against `POST /mcp`, which in practice means an external agent harness.
 *
 * It deliberately does not name the client. Two agent harnesses are the same thing to an operator
 * asking "did a person or an agent change this diagram", and recording a client-supplied name would
 * put an unverified value into an operational log.
 *
 * The administrative events (`admin_diagram_opened`, `admin_diagram_deleted`) deliberately carry no
 * `via` field. They are named for the surface that emits them and no MCP tool can reach them, so a
 * constant `'api'` there would be a value that could never vary — which reads as a question worth
 * asking rather than one already answered.
 */
export type LogVia = 'api' | 'mcp';
