/**
 * @file The chat turn's tool set: which tools pause for approval, what idempotency key an approved
 *   write actually sends, and what a failure looks like to the model. These are the safety
 *   properties of the chat surface (`specs/ignite-crm/05-ai-features.md` §3.5, §4.3), and they are
 *   asserted here as ordinary functions rather than through a running agent, so a regression shows
 *   up as a failing unit test rather than as a behaviour nobody notices.
 */

import type { ToolSet } from 'ai';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createAgentTools } from '../../../src/application-worker/agent/tools.ts';
import { deriveIdempotencyKey } from '../../../src/application-worker/chat/idempotency.ts';
import { buildChatTools, chatMutationSchema } from '../../../src/application-worker/chat/tools.ts';
import { serviceError } from '../../../src/shared/common/errors.ts';
import type { ActorContext, DataService } from '../../../src/shared/data-service/contract.ts';

/**
 * The verified actor a chat turn runs as.
 */
const ACTOR: ActorContext = {
  email: 'sales@example.com',
  userId: '00000000-0000-4000-8000-000000000001',
  requestId: 'turn-1',
  channel: 'chat'
};

/**
 * A contact the create tool accepts.
 */
const CONTACT = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: null,
  jobTitle: 'Analyst',
  companyId: null,
  companyName: 'Analytical Engines'
};

/**
 * Call one tool from a built tool set.
 *
 * @param tools The built tool set.
 * @param name Tool to call.
 * @param input Arguments.
 * @param toolCallId Tool call identifier the model's call carries.
 * @returns Whatever the tool resolved with.
 */
async function callTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  toolCallId = 'call-1'
): Promise<unknown> {
  const entry = tools[name];
  if (entry?.execute === undefined) {
    throw new Error(`The tool set has no executable ${name}.`);
  }
  return entry.execute(input, { toolCallId, messages: [], context: undefined } as never);
}

/**
 * Build a tool set over a Data Service double.
 *
 * @param data The double.
 * @param requestId Chat request identifier.
 * @returns The tool set.
 */
function toolsOver(data: DataService, requestId = ACTOR.requestId): ToolSet {
  return buildChatTools(createAgentTools(), { data, actor: ACTOR }, requestId);
}

describe('chat tool set', () => {
  it('requires approval for every mutating tool and for no read tool', () => {
    const tools = toolsOver({} as DataService);

    for (const definition of createAgentTools()) {
      const entry = tools[definition.name];
      expect(entry, definition.name).toBeDefined();
      // Uniform by design: approving only the high-impact writes would make the safety story
      // conditional on a per-tool judgement (§3.5).
      expect(Boolean(entry?.needsApproval), definition.name).toBe(definition.mutates);
    }
  });

  it('sends a derived idempotency key, ignoring any the model invented', async () => {
    const keys: string[] = [];
    const data = {
      crm: {
        createContact: (_actor: unknown, _input: unknown, options: { idempotencyKey: string }) => {
          keys.push(options.idempotencyKey);
          return Promise.resolve({ id: 'created' });
        }
      }
    } as unknown as DataService;
    const tools = toolsOver(data);

    await callTool(tools, 'create_contact', { ...CONTACT, idempotencyKey: 'model-invented' });
    await callTool(tools, 'create_contact', { ...CONTACT, idempotencyKey: 'model-invented' });

    // Same turn, same tool call: the second attempt is a replay in the Data Worker, not a second
    // contact. The model's own key never reaches it.
    expect(keys).toEqual([
      deriveIdempotencyKey('turn-1', 'call-1'),
      deriveIdempotencyKey('turn-1', 'call-1')
    ]);
    expect(keys).not.toContain('model-invented');
  });

  it('gives two tool calls in one turn distinct keys', async () => {
    const keys: string[] = [];
    const data = {
      crm: {
        createContact: (_actor: unknown, _input: unknown, options: { idempotencyKey: string }) => {
          keys.push(options.idempotencyKey);
          return Promise.resolve({ id: 'created' });
        }
      }
    } as unknown as DataService;
    const tools = toolsOver(data);

    await callTool(tools, 'create_contact', CONTACT, 'call-1');
    await callTool(tools, 'create_contact', CONTACT, 'call-2');

    expect(new Set(keys).size).toBe(2);
  });

  it('reports a refused record without enumerating it', async () => {
    const data = {
      crm: {
        getContact: () =>
          Promise.reject(
            serviceError('FORBIDDEN', 'Contact 123 belongs to another team.', {
              retryable: false,
              requestId: 'turn-1'
            })
          )
      }
    } as unknown as DataService;

    const result = await callTool(toolsOver(data), 'get_contact', {
      id: '00000000-0000-4000-8000-0000000000b1'
    });

    expect(result).toEqual({
      code: 'FORBIDDEN',
      message: 'The requested record is not available.',
      retryable: false,
      requestId: 'turn-1'
    });
    // The Data Worker's own wording could name a record the caller may not see, so it is replaced.
    expect(JSON.stringify(result)).not.toContain('another team');
  });

  it('turns an unexpected failure into a safe, retryable answer rather than throwing', async () => {
    const data = {
      crm: { getDeal: () => Promise.reject(new TypeError('socket hang up at line 42')) }
    } as unknown as DataService;

    const result = await callTool(toolsOver(data), 'get_deal', {
      id: '00000000-0000-4000-8000-0000000000d1'
    });

    expect(result).toEqual({
      code: 'INTERNAL',
      message: 'The assistant could not complete that request.',
      retryable: true,
      requestId: 'turn-1'
    });
    expect(JSON.stringify(result)).not.toContain('line 42');
  });
});

describe('chat mutation schemas', () => {
  it('accepts a mutation without an idempotency key, because the server derives it', () => {
    const create = createAgentTools().find((entry) => entry.name === 'create_contact');
    const schema = chatMutationSchema(create!.input);

    expect(v.safeParse(schema, CONTACT).success).toBe(true);
  });

  it('still rejects a smuggled actor field', () => {
    const create = createAgentTools().find((entry) => entry.name === 'create_contact');
    const schema = chatMutationSchema(create!.input);

    for (const field of ['actor', 'actorId', 'userId', 'role', 'roles', 'permissions']) {
      expect(v.safeParse(schema, { ...CONTACT, [field]: 'owner@example.com' }).success, field).toBe(
        false
      );
    }
  });

  it('keeps accepting a contact’s own e-mail, which is domain data rather than identity', () => {
    const create = createAgentTools().find((entry) => entry.name === 'create_contact');
    const schema = chatMutationSchema(create!.input);

    expect(v.safeParse(schema, { ...CONTACT, email: 'ada@example.com' }).success).toBe(true);
  });

  it('still rejects arguments the domain schema does not accept', () => {
    const create = createAgentTools().find((entry) => entry.name === 'create_contact');
    const schema = chatMutationSchema(create!.input);

    expect(v.safeParse(schema, { ...CONTACT, unexpected: true }).success).toBe(false);
  });
});
