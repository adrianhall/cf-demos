/**
 * @file The scripted development model. It stands in for Workers AI during `pnpm start` and the
 *   Playwright journeys, so its two load-bearing properties are: it never reaches the network, and
 *   it only ever calls a tool the caller was actually offered. Its gate is asserted here as well.
 *   `useDevelopmentModel()` returns `import.meta.env.DEV`, which every `vite build` compiles to a
 *   literal `false` — so a deployed Worker can only reach Workers AI. That is the same rule the
 *   development-token bypass follows, and it is worth a test for the same reason: a substitute
 *   model in a deployment would be a silent correctness failure.
 */

import { describe, expect, it } from 'vitest';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  createDevelopmentModel,
  useDevelopmentModel
} from '../../../src/application-worker/chat/development-model.ts';

/**
 * Read one turn from the model.
 *
 * @param said The user's message.
 * @param offered Tool names the caller was offered.
 * @param options Extra prompt pieces: a page-context hint, or a trailing tool result.
 * @returns The parts the model streamed.
 */
async function turn(
  said: string,
  offered: readonly string[],
  options: { context?: string; afterTool?: boolean } = {}
): Promise<LanguageModelV4StreamPart[]> {
  const system = [
    'You are the Ignite CRM assistant.',
    ...(options.context === undefined
      ? []
      : [`The user is currently looking at the contact with id ${options.context}.`])
  ].join('\n');
  const prompt = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: said }] },
    ...(options.afterTool === true
      ? [
          {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'c1', toolName: offered[0], output: {} }]
          }
        ]
      : [])
  ] as LanguageModelV4CallOptions['prompt'];

  const { stream } = await createDevelopmentModel().doStream({
    prompt,
    tools: offered.map((name) => ({ type: 'function', name, inputSchema: {} }))
  } as LanguageModelV4CallOptions);

  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    parts.push(next.value);
  }
  return parts;
}

/**
 * The tool call in a turn, if there is one.
 *
 * @param parts Streamed parts.
 * @returns The call, or `undefined`.
 */
function toolCall(
  parts: readonly LanguageModelV4StreamPart[]
): { toolName: string; input: string } | undefined {
  const call = parts.find((part) => part.type === 'tool-call');
  return call?.type === 'tool-call' ? { toolName: call.toolName, input: call.input } : undefined;
}

/**
 * The text in a turn.
 *
 * @param parts Streamed parts.
 * @returns The concatenated text.
 */
function text(parts: readonly LanguageModelV4StreamPart[]): string {
  return parts
    .filter((part) => part.type === 'text-delta')
    .map((part) => (part.type === 'text-delta' ? part.delta : ''))
    .join('');
}

describe('the development model gate', () => {
  it('follows import.meta.env.DEV, so a built bundle can only reach Workers AI', () => {
    expect(useDevelopmentModel()).toBe(import.meta.env.DEV);
  });
});

describe('the scripted development model', () => {
  it('reads the pipeline through a tool rather than answering from nothing', async () => {
    const parts = await turn('How is the pipeline?', ['pipeline_summary', 'create_note']);

    expect(toolCall(parts)?.toolName).toBe('pipeline_summary');
  });

  it('writes a note against the record the page-context hint names', async () => {
    const id = '00000000-0000-4000-8000-0000000000b1';

    const parts = await turn('Write a note about renewal', ['create_note'], { context: id });

    const call = toolCall(parts);
    expect(call?.toolName).toBe('create_note');
    // A note must link to at least one record, and a real model would learn which from the prompt.
    expect(JSON.parse(call!.input)).toMatchObject({ links: [{ type: 'contact', id }] });
  });

  it('asks the user to open a record first when there is no hint to work from', async () => {
    const parts = await turn('Write a note about renewal', ['create_note']);

    expect(toolCall(parts)).toBeUndefined();
    expect(text(parts)).toContain('Open the contact you want the note on first');
  });

  it('never calls a tool the caller was not offered', async () => {
    const parts = await turn('How is the pipeline? Write a note too.', ['whoami']);

    expect(toolCall(parts)).toBeUndefined();
    expect(text(parts)).toContain('local development assistant');
  });

  it('answers rather than calling another tool once a result is in', async () => {
    const parts = await turn('How is the pipeline?', ['pipeline_summary'], { afterTool: true });

    expect(toolCall(parts)).toBeUndefined();
    expect(text(parts)).toContain('your own CRM data');
  });

  it('does not implement non-streaming generation, which the agent never uses', async () => {
    expect(() => createDevelopmentModel().doGenerate({} as LanguageModelV4CallOptions)).toThrow(
      'streams'
    );
  });
});
