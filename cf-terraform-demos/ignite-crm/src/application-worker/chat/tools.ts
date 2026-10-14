/**
 * @file Turning the shared agent catalogue into the AI SDK tool set one chat turn is given. Kept
 *   out of `./chat-agent.ts` deliberately: nothing here touches the Durable Object, the Workers
 *   runtime, or the model, so all of it — approval gating, key derivation, and error presentation —
 *   is tested directly as ordinary functions rather than through a running agent.
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { isServiceError } from '../../shared/common/errors.ts';
import { presentToolError } from '../agent/errors.ts';
import type { AgentTool, AgentToolContext } from '../agent/tools.ts';
import { CHAT_IDEMPOTENCY_PLACEHOLDER, deriveIdempotencyKey } from './idempotency.ts';

/**
 * Adapt a mutating tool's catalogue schema for the chat transport.
 *
 * The catalogue requires an `idempotencyKey` on every mutation, because an MCP caller supplies its
 * own. A model must not: the key has to be **derived** from the turn and the tool call so that a
 * replayed approval is a replay rather than a second record (`./idempotency.ts`). The schema the
 * model is shown therefore fills the key in with {@link CHAT_IDEMPOTENCY_PLACEHOLDER} before the
 * catalogue's own rules are applied, and {@link buildChatTools} replaces it with the real value at
 * execution.
 *
 * A key the model invents anyway is overwritten rather than honoured, so it can neither make two
 * distinct writes collide nor make one write duplicate.
 *
 * @param schema The catalogue's mutation schema.
 * @returns A schema accepting the same arguments without a caller-supplied idempotency key.
 */
export function chatMutationSchema(schema: v.GenericSchema): v.GenericSchema {
  return v.pipe(
    v.record(v.string(), v.unknown()),
    v.transform((input) => ({ idempotencyKey: CHAT_IDEMPOTENCY_PLACEHOLDER, ...input })),
    v.check(
      (input) => v.safeParse(schema, input).success,
      'The arguments do not match this tool’s schema.'
    )
  ) as v.GenericSchema;
}

/**
 * Present a catalogue schema to the AI SDK.
 *
 * The AI SDK accepts a Standard Schema, but it cannot _derive JSON Schema_ from a Valibot one — it
 * knows how to do that only for Zod — and the provider needs JSON Schema to describe the tool to
 * the model. Without this adapter a turn fails with "Standard schema vendor 'valibot' does not
 * support JSON Schema conversion", which is a runtime failure rather than a type error, so a
 * Workers-runtime test pins it.
 *
 * The repository's rule is Valibot everywhere and no second schema library
 * (`specs/ignite-crm/05-ai-features.md` §6.2), so the conversion is done with
 * `@valibot/to-json-schema` — exactly as the MCP surface already does — and validation stays with
 * Valibot itself. One schema object therefore still serves both surfaces.
 *
 * @param schema The catalogue's schema for a tool's input.
 * @returns A schema the AI SDK can both validate with and describe to a provider.
 */
function toolInputSchema(schema: v.GenericSchema): ReturnType<typeof jsonSchema> {
  return jsonSchema(
    // `errorMode: 'ignore'` keeps a construct JSON Schema cannot express (a `check` predicate, for
    // instance) from failing the conversion: the description the model sees is a little looser, and
    // Valibot still rejects the call if the arguments do not satisfy the real schema.
    () => toJsonSchema(schema, { errorMode: 'ignore' }),
    {
      validate: (value) => {
        const parsed = v.safeParse(schema, value);
        return parsed.success
          ? { success: true, value: parsed.output }
          : { success: false, error: new Error(parsed.issues[0]?.message ?? 'Invalid arguments.') };
      }
    }
  );
}

/**
 * Build the AI SDK tool set for one turn from the caller's permitted runtime tools.
 *
 * Every mutating tool is declared `needsApproval`, without exception: the stream pauses, the panel
 * renders an approval card, and nothing reaches the Data Worker until the user approves
 * (`specs/ignite-crm/05-ai-features.md` §3.5). Approving only the high-impact tools would be
 * smoother to use but would make the safety story conditional on a judgement a reader copying this
 * demo would have to re-make for their own domain.
 *
 * @param tools Runtime tools the caller is permitted to use, already filtered by capability.
 * @param context Verified actor and the authoritative Data Service client.
 * @param requestId Identifier of the chat request this turn belongs to, from which each approved
 *   mutation's idempotency key is derived.
 * @returns Tools in AI SDK form. Each resolves either to the tool's own result or to a safe
 *   {@link presentToolError} value; none of them throws, because a tool failure is something the
 *   model has to be _told_ about rather than a crash.
 */
export function buildChatTools(
  tools: readonly AgentTool[],
  context: AgentToolContext,
  requestId: string
): ToolSet {
  const entries = tools.map((entry) => [
    entry.name,
    tool({
      description: entry.description,
      inputSchema: toolInputSchema(entry.mutates ? chatMutationSchema(entry.input) : entry.input),
      ...(entry.mutates ? { needsApproval: true } : {}),
      execute: async (input: unknown, options: { toolCallId: string }) => {
        const values = entry.mutates
          ? {
              ...(input as Record<string, unknown>),
              idempotencyKey: deriveIdempotencyKey(requestId, options.toolCallId)
            }
          : input;
        try {
          return await entry.execute(context, values);
        } catch (error) {
          // Non-enumerating and content-free: a record the caller may not see produces the same
          // answer as one that does not exist, and no stored content is echoed back.
          if (isServiceError(error)) {
            return presentToolError(error);
          }
          return {
            code: 'INTERNAL',
            message: 'The assistant could not complete that request.',
            retryable: true,
            requestId: context.actor.requestId
          };
        }
      }
    })
  ]);
  return Object.fromEntries(entries) as ToolSet;
}
