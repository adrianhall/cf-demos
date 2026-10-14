/**
 * @file Chat session naming. The identifier must be derived (so reopening the panel rejoins the
 *   same conversation), stable (so a reload does too), per-user (so one user's name is never
 *   another's), and shaped like every other identifier in the system (so the wire schema accepts
 *   it).
 */

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  chatInstanceName,
  deriveChatSessionId
} from '../../../src/application-worker/chat/session.ts';
import { ChatSessionSchema } from '../../../src/shared/api/chat.ts';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';

describe('chat session identifiers', () => {
  it('is stable for one user, so a reload rejoins the same conversation', async () => {
    const first = await deriveChatSessionId(ALICE);
    const second = await deriveChatSessionId(ALICE);

    expect(second).toBe(first);
  });

  it('differs between users', async () => {
    expect(await deriveChatSessionId(ALICE)).not.toBe(await deriveChatSessionId(BOB));
  });

  it('is a lowercase UUID, so the wire schema accepts it', async () => {
    const sessionId = await deriveChatSessionId(ALICE);

    expect(v.safeParse(ChatSessionSchema, { sessionId }).success).toBe(true);
    expect(sessionId).toBe(sessionId.toLowerCase());
  });

  it('names the Durable Object instance with both halves', async () => {
    const sessionId = await deriveChatSessionId(ALICE);

    expect(chatInstanceName(ALICE, sessionId)).toBe(`${ALICE}:${sessionId}`);
  });
});
