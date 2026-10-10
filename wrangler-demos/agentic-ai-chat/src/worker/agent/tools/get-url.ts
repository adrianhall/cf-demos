import { tool } from "ai";
import { z } from "zod";
import type { EgressGatewayProps } from "../../egress/gateway";
import {
  SANDBOXED_FETCH_WORKER_COMPATIBILITY_DATE,
  SANDBOXED_FETCH_WORKER_MODULE,
} from "../../egress/sandboxed-fetch-worker";
import { validateUrlFloor } from "../../egress/url-validation";

/**
 * `getUrl` tool (docs/06-AGENTIC-CHAT.md Phase 10, US-9): lets the agent look something up on
 * the web when asked, with access controlled at the platform layer rather than left
 * unrestricted. Zod-validated at the AI SDK level (a malformed tool call never reaches
 * {@link fetchUrl} at all); {@link validateUrlFloor} is this module's own *additional*,
 * defense-in-depth check a schema alone cannot express (an http(s)-only scheme, no
 * obviously-internal address literal) -- the real enforcement is `EgressGateway`'s allow-list
 * (`../../egress/gateway.ts`), never this floor alone (AGENTS.md's "Least privilege").
 */
export const getUrlInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'The absolute http(s) URL to fetch, for example "https://developers.cloudflare.com/workers/".',
    ),
});

/** Validated input to {@link fetchUrl}. */
export type GetUrlInput = z.infer<typeof getUrlInputSchema>;

/** The tool result returned to the model -- shaped so a failure, blocked or otherwise (Section
 * 11: "never let a tool failure throw an unhandled exception that aborts the whole streaming
 * response"), is always a plain, explainable value, never a thrown error. `blocked` lets the
 * model (and this module's own tests) distinguish "the platform's egress policy refused this
 * destination" from every other failure shape, without string-matching an error message. */
export type GetUrlOutput =
  | { readonly success: true; readonly url: string; readonly content: string }
  | {
      readonly success: false;
      readonly blocked: boolean;
      readonly error: string;
    };

/** Collaborators {@link fetchUrl} needs, threaded in by `ChatAgent.onChatMessage()`
 * (`../chat-agent.ts`) rather than imported directly, so this function stays testable with
 * plain fakes instead of real Cloudflare bindings -- mirrors `./write-markdown.ts`'s own
 * `WriteMarkdownDeps` convention. */
export interface GetUrlDeps {
  /** Worker Loader binding (`LOADER`) this tool loads the sandboxed fetch Worker through. */
  readonly loader: WorkerLoader;
  /** The calling `ChatAgent`'s own instance name -- threaded into the gateway's `props` for
   * per-chat logging/scoping (docs/06-AGENTIC-CHAT.md Section 6.7). */
  readonly chatId: string;
  /** Builds this call's `globalOutbound` gateway stub, deferred behind a factory (rather than
   * a pre-built `Fetcher`) so a test can inject a fake with no real `ctx.exports` involved --
   * `ChatAgent` passes `(props) => this.ctx.exports.EgressGateway({ props })`, per Spike C's
   * confirmed finding that `ctx.exports` is directly reachable from inside a Durable Object
   * method. */
  readonly createGlobalOutboundGateway: (props: EgressGatewayProps) => Fetcher;
}

/** Name the sandboxed Dynamic Worker is cached under (docs/06-AGENTIC-CHAT.md Section 6.7):
 * `env.LOADER.get()` reuses the already-loaded worker for this name across calls within the
 * same isolate rather than reloading its code every time -- correct here since the sandboxed
 * module's own code never changes per call. */
const GET_URL_TOOL_WORKER_NAME = "get-url-tool";

/**
 * Validate one `getUrl` call's input, then run it through the sandboxed Dynamic Worker's
 * `globalOutbound` egress gateway (docs/06-AGENTIC-CHAT.md Section 6.7). Every failure path --
 * an invalid/internal URL, a blocked destination, a Dynamic Worker load failure, or an upstream
 * non-2xx response -- returns a structured {@link GetUrlOutput} failure rather than throwing,
 * so a tool problem never aborts the model's whole turn (Section 11).
 *
 * @param deps Collaborators (Worker Loader, owning chat id, gateway factory).
 * @param input The model's validated tool-call arguments.
 * @returns A success result (the fetched, bounded content) or a structured failure the model
 * can explain to the user.
 */
export async function fetchUrl(
  deps: GetUrlDeps,
  input: GetUrlInput,
): Promise<GetUrlOutput> {
  const validation = validateUrlFloor(input.url);
  if (!validation.ok) {
    return { success: false, blocked: false, error: validation.error };
  }

  let response: Response;
  try {
    const worker = deps.loader.get(GET_URL_TOOL_WORKER_NAME, () => ({
      compatibilityDate: SANDBOXED_FETCH_WORKER_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: { "index.js": SANDBOXED_FETCH_WORKER_MODULE },
      // `get()`, not `load()`: this module's own code never changes per call, so the Dynamic
      // Worker is loaded once and kept warm across this chat's own repeated getUrl calls
      // (docs/06-AGENTIC-CHAT.md Section 6.7).
      globalOutbound: deps.createGlobalOutboundGateway({ chatId: deps.chatId }),
    }));
    response = await worker
      .getEntrypoint()
      .fetch(
        new Request(
          `https://get-url-tool.invalid/?url=${encodeURIComponent(validation.url)}`,
        ),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "get_url_dynamic_worker_failed",
        chatId: deps.chatId,
        error: String(error),
      }),
    );
    return {
      success: false,
      blocked: false,
      error: "The URL could not be fetched.",
    };
  }

  const body = await response.text();

  // The sandboxed module (`../../egress/sandboxed-fetch-worker.ts`) reports a deliberate block
  // as `403`, distinct from every other failure shape -- see that module's own JSDoc for why
  // this is a status-code distinction, not a string match on `body`.
  if (response.status === 403) {
    return { success: false, blocked: true, error: body };
  }
  if (!response.ok) {
    return {
      success: false,
      blocked: false,
      error: `Fetching "${validation.url}" failed (status ${response.status}).`,
    };
  }
  return { success: true, url: validation.url, content: body };
}

/**
 * Build the `getUrl` tool for one turn's `streamText()` call (`ChatAgent.onChatMessage()`),
 * bound to this chat's own Worker Loader binding and egress gateway.
 *
 * @param deps Collaborators for the built tool's `execute()` function.
 * @returns An `ai` SDK tool, ready to include in `streamText()`'s `tools` option.
 */
export function createGetUrlTool(deps: GetUrlDeps) {
  return tool({
    description:
      "Fetch the text content of a URL on the public web, so you can answer questions about " +
      "its content. Only a small set of allow-listed destinations can actually be reached -- " +
      "a disallowed destination is refused, and you should explain that refusal to the user " +
      "rather than treating it as an error.",
    inputSchema: getUrlInputSchema,
    execute: (input) => fetchUrl(deps, input),
  });
}
