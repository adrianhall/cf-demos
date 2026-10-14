/**
 * @file The chat agent as the Workers-runtime suite runs it: the real `CrmChatAgent`, with only its
 *   model replaced. Everything else is genuine — the Durable Object, its SQLite storage, the
 *   Access-authenticated route, the RPC boundary to the Data Worker, the approval protocol, and the
 *   schedules. What is substituted is the one thing a test must never call: Workers AI
 *   (`specs/ignite-crm/05-ai-features.md` §7.2). The script is set through a module-level variable
 *   rather than through the agent's props, because props are the verified identity and nothing
 *   test-shaped belongs in them. This module is only ever reachable from `./system-entry.ts`, which
 *   is the test entrypoint.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { CrmChatAgent } from '../../src/application-worker/chat/chat-agent.ts';
import { createFakeModel, type FakeModelLog, type FakeModelStep } from './fake-model.ts';

/**
 * The model the next turn will use, and the log of what it was asked.
 */
let current: { model: LanguageModelV4; log: FakeModelLog } = createFakeModel([]);

/**
 * Script the model for the turns that follow.
 *
 * @param script Steps per model call.
 * @returns The log the scripted model will fill in.
 */
export function scriptModel(script: FakeModelStep[][]): FakeModelLog {
  current = createFakeModel(script);
  return current.log;
}

/**
 * The real chat agent with a scripted model.
 */
export class TestChatAgent extends CrmChatAgent {
  /**
   * Use the scripted model instead of Workers AI.
   *
   * @returns The scripted model.
   */
  protected override model(): never {
    return current.model as never;
  }
}
