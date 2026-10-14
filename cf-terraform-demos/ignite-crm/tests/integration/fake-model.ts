/**
 * @file A deterministic language model for the Workers-runtime chat suite. The tests assert the
 *   turn loop, the tools, and the permissions — never the prose — so the model is a script rather
 *   than an inference call. **No test calls Workers AI** (`specs/ignite-crm/05-ai-features.md`
 *   §7.2): the free allowance is finite, a real model's output is not reproducible, and a test that
 *   depended on either would be flaky and expensive. It implements the AI SDK's provider interface
 *   directly, so everything between the stream and the browser — tool-call handling, approval
 *   pausing, persistence, resumption — is the real thing.
 */

import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';

/**
 * One scripted step of a conversation.
 */
export type FakeModelStep =
  | {
      /**
       * Emit text.
       */
      readonly type: 'text';
      /**
       * The text to emit.
       */
      readonly text: string;
    }
  | {
      /**
       * Call a tool.
       */
      readonly type: 'tool';
      /**
       * Tool name, which must be one the caller was offered.
       */
      readonly name: string;
      /**
       * Arguments for the call.
       */
      readonly input: unknown;
    };

/**
 * What the fake model recorded about the calls made to it.
 */
export interface FakeModelLog {
  /**
   * Tool names offered to the model, per call, so a test can assert what a role was shown.
   */
  readonly offeredTools: string[][];
  /**
   * System prompts the model was given, so a test can assert the capability header.
   */
  readonly prompts: string[];
}

/**
 * Build a model that plays a fixed script.
 *
 * Each entry of `script` is one model call: the first is the user's turn, the second is the
 * continuation after a tool result, and so on. When the script runs out, the model answers with a
 * closing sentence, which is what ends the turn.
 *
 * @param script Steps to play, one array per model call.
 * @returns The model and the log of what it was asked.
 */
export function createFakeModel(script: FakeModelStep[][]): {
  model: LanguageModelV4;
  log: FakeModelLog;
} {
  const offeredTools: string[][] = [];
  const prompts: string[] = [];
  let call = 0;

  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'fake',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('The chat agent streams; doGenerate is never used.');
    },
    doStream: (options) => {
      const index = call;
      call += 1;
      offeredTools.push((options.tools ?? []).map((tool) => tool.name));
      const system = options.prompt.find((message) => message.role === 'system');
      prompts.push(
        system?.role === 'system' && typeof system.content === 'string' ? system.content : ''
      );
      const steps = script[index] ?? [{ type: 'text' as const, text: 'Done.' }];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          let toolCalls = 0;
          for (const [position, step] of steps.entries()) {
            if (step.type === 'text') {
              const id = `text-${index}-${position}`;
              controller.enqueue({ type: 'text-start', id });
              controller.enqueue({ type: 'text-delta', id, delta: step.text });
              controller.enqueue({ type: 'text-end', id });
              continue;
            }
            toolCalls += 1;
            controller.enqueue({
              type: 'tool-call',
              toolCallId: `call-${index}-${position}`,
              toolName: step.name,
              input: JSON.stringify(step.input)
            });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: {
              unified: toolCalls > 0 ? 'tool-calls' : 'stop',
              raw: undefined
            },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 }
            }
          });
          controller.close();
        }
      });

      return Promise.resolve({ stream });
    }
  };

  return { model, log: { offeredTools, prompts } };
}
