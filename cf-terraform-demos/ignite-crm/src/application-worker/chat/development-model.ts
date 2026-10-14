/**
 * @file A scripted model for local development and the Playwright journeys.
 *
 *   ## Why this exists
 *
 *   `pnpm start` and `pnpm test:e2e` run offline against local resource simulations, and Workers AI
 *   is not one of them: the `AI` binding in local development calls the **real** service. A browser
 *   journey that opened the panel and asked a question would therefore spend the account's
 *   allowance, produce different prose every run, and fail without network access — which is
 *   exactly what the repository's "tests must pass offline" rule forbids. The specification asks
 *   for the journey with the model faked at the Worker boundary (§7.4), and this is that boundary.
 *
 *   ## Why it cannot reach a deployment
 *
 *   {@link useDevelopmentModel} is gated on `import.meta.env.DEV`, which every `vite build`
 *   compiles to a literal `false`. The branch — and this whole module with it — is removed from any
 *   built bundle, exactly as the development-token bypass is. The same rule, for the same reason: a
 *   substitute model in a deployed Worker would be a silent correctness failure.
 *
 *   ## What it answers
 *
 *   Enough to drive the feature as a user meets it: a greeting, a grounded read through
 *   `pipeline_summary`, and an approval-gated `create_note`. It is a fixture, not an assistant.
 */

import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';

/**
 * Whether the scripted model should stand in for Workers AI.
 *
 * @returns `true` only in a development build; statically `false` in every built bundle.
 */
export function useDevelopmentModel(): boolean {
  return import.meta.env.DEV;
}

/**
 * What the scripted model does for one turn, chosen from the user's latest message.
 */
interface ScriptedTurn {
  /**
   * The tool to call, if any.
   */
  readonly tool?: { name: string; input: Record<string, unknown> };
  /**
   * The text to answer with.
   */
  readonly text: string;
}

/**
 * Choose a reply for the user's latest message.
 *
 * Keyword matching, deliberately: the point is a predictable fixture a journey can assert, not an
 * imitation of a model.
 *
 * @param message The user's latest message text.
 * @param offered Tool names the caller was offered, so the script never calls one they lack.
 * @param contextId The record named by the panel's page-context hint, when there is one. A note
 *   must link to at least one record, and this is how a real model would learn which: from the
 *   prompt.
 * @returns The scripted turn.
 */
function scriptFor(
  message: string,
  offered: readonly string[],
  contextId: string | undefined
): ScriptedTurn {
  const text = message.toLowerCase();
  if (text.includes('pipeline') && offered.includes('pipeline_summary')) {
    return { tool: { name: 'pipeline_summary', input: {} }, text: '' };
  }
  if (text.includes('note') && offered.includes('create_note')) {
    if (contextId === undefined) {
      return { text: 'Open the contact you want the note on first, then ask me again.' };
    }
    return {
      tool: {
        name: 'create_note',
        input: {
          title: `Assistant note: ${message}`.slice(0, 200),
          markdown: message,
          links: [{ type: 'contact', id: contextId }]
        }
      },
      text: ''
    };
  }
  return {
    text: 'I am the local development assistant. Ask about the pipeline, or ask me to write a note.'
  };
}

/**
 * The record identifier the page-context hint put in the system prompt.
 *
 * @param system The system prompt for this turn.
 * @returns The identifier, or `undefined` when the panel sent no hint.
 */
function contextIdFrom(system: string): string | undefined {
  return /looking at the \w+ with id ([0-9a-f-]{36})/u.exec(system)?.[1];
}

/**
 * Build the scripted development model.
 *
 * @returns A model that answers from {@link scriptFor} and never makes a network request.
 */
export function createDevelopmentModel(): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'ignite-crm-development',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('The chat agent streams; doGenerate is never used.');
    },
    doStream: (options) => {
      const offered = (options.tools ?? []).map((tool) => tool.name);
      const last = [...options.prompt].reverse().find((message) => message.role === 'user');
      const said = Array.isArray(last?.content)
        ? last.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(' ')
            .trim()
        : '';
      // A continuation — the step right after a tool result — must answer rather than call another
      // tool, or the loop would never settle. Only the *last* message decides that: an earlier turn's
      // tool result is still in the transcript, so asking whether one appears anywhere would make
      // every message after the first a continuation.
      const answered = options.prompt.at(-1)?.role === 'tool';
      const system = options.prompt.find((message) => message.role === 'system');
      const turn: ScriptedTurn = answered
        ? { text: 'Done — that came from your own CRM data.' }
        : scriptFor(
            said,
            offered,
            contextIdFrom(typeof system?.content === 'string' ? system.content : '')
          );

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          if (turn.tool !== undefined) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: `dev-${Date.now()}`,
              toolName: turn.tool.name,
              input: JSON.stringify(turn.tool.input)
            });
          } else {
            const id = 'dev-text';
            controller.enqueue({ type: 'text-start', id });
            controller.enqueue({ type: 'text-delta', id, delta: turn.text });
            controller.enqueue({ type: 'text-end', id });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: {
              unified: turn.tool === undefined ? 'stop' : 'tool-calls',
              raw: undefined
            },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 }
            }
          });
          controller.close();
        }
      });

      return Promise.resolve({ stream });
    }
  };
}
