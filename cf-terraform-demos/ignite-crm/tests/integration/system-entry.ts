/**
 * @file Test-only Worker module combining both Workers so a loopback service binding can connect
 *   them (see `./vitest.config.ts`). `CrmChatAgent` is exported as `./chat-agent-under-test.ts`'s
 *   subclass: the real agent, with only its model replaced, so no test calls Workers AI. The
 *   Durable Object, its storage, and every other path are the deployed ones.
 */

export { default } from '../../src/application-worker/index.ts';
export { DataEntrypoint } from '../../src/data-worker/index.ts';
export { TestChatAgent as CrmChatAgent } from './chat-agent-under-test.ts';
