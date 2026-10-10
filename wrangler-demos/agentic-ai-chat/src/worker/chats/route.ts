/**
 * Governed AI Gateway dynamic-route selection (docs/06-AGENTIC-CHAT.md Phase 4, US-3). A chat
 * never carries a raw model id anywhere client-visible -- only one of these two literal
 * strings, which {@link resolveDynamicRouteModelId} maps to the actual, Terraform-provisioned
 * dynamic route name (Section 6.3's "the client sends a route name, not a model id" rule).
 */
export type ChatRoute = "basic" | "reasoning";

/** Every valid {@link ChatRoute}, in the order the UI's dropdown should offer them. */
export const CHAT_ROUTES: readonly ChatRoute[] = ["basic", "reasoning"];

/** The route a newly created chat starts with, and the one an invalid/missing stored value
 * falls back to (US-3's "defaulting to Basic" acceptance criterion). */
export const DEFAULT_CHAT_ROUTE: ChatRoute = "basic";

/**
 * Narrow an arbitrary value (client request body, a D1 column read back) to a {@link ChatRoute}
 * by exact match -- the one place this demo decides whether a route selection is valid at all.
 * Rejecting anything else here, before it ever reaches {@link resolveDynamicRouteModelId} or a
 * D1 write, is what Section 6.3 means by "the Worker resolves by exact match, never interpolates
 * a client-supplied string into a model id."
 *
 * @param value Untyped input to check.
 * @returns Whether `value` is exactly `"basic"` or `"reasoning"`.
 */
export function isChatRoute(value: unknown): value is ChatRoute {
  return value === "basic" || value === "reasoning";
}

/**
 * Resolve a validated {@link ChatRoute} to the literal `dynamic/<route-name>` string
 * `workers-ai-provider`'s `WorkersAI` accepts as a model id (confirmed by Spike B/F:
 * `env.AI.run("dynamic/<name>", ...)` calls the named AI Gateway dynamic route, and
 * `workers-ai-provider` forwards a `"dynamic/..."` model id to that same run path unchanged).
 * The real route names are Terraform outputs threaded into these two Worker vars
 * (`infra/outputs.tf`'s `ai_gateway_route_basic`/`ai_gateway_route_reasoning`,
 * `wrangler.jsonc.tpl`) rather than hard-coded here, so renaming a route in Terraform needs no
 * application-code change.
 *
 * @param route The chat's selected route, already validated by {@link isChatRoute}.
 * @param env Worker bindings carrying both routes' real names. Deliberately typed as a plain
 * `string`-keyed shape rather than `Pick<Env, ...>`: this repo's generated `Env` narrows each
 * `wrangler.jsonc` var to its own literal string value (confirmed for `AI_GATEWAY_ID` already,
 * and now these two), which would make this function's signature reject any differently-valued
 * `Env`-shaped object a unit test constructs -- widening to plain `string` here keeps `this.env`
 * (whatever literal values a given deployment's generated types pin it to) assignable without
 * narrowing the function's own useful type checking (`route` still can't be anything but a
 * {@link ChatRoute}).
 * @returns A model id ready to pass to `workers-ai-provider`'s `WorkersAI` function, for
 * example `"dynamic/agentic-chat-basic"`.
 */
export function resolveDynamicRouteModelId(
  route: ChatRoute,
  env: { AI_GATEWAY_ROUTE_BASIC: string; AI_GATEWAY_ROUTE_REASONING: string },
): string {
  const routeName =
    route === "reasoning"
      ? env.AI_GATEWAY_ROUTE_REASONING
      : env.AI_GATEWAY_ROUTE_BASIC;
  return `dynamic/${routeName}`;
}
