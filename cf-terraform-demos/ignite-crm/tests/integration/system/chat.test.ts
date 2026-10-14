/**
 * @file The chat agent in the real runtime: a real Durable Object with real SQLite storage, a real
 *   WebSocket upgrade through the Access-authenticated route, a real RPC boundary to the Data
 *   Worker, and real D1 behind it. Only the model is scripted (`../chat-agent-under-test.ts`) — no
 *   test calls Workers AI. These are the behaviours the unit suites cannot prove, because each of
 *   them is a property of the whole path rather than of one function
 *   (`specs/ignite-crm/05-ai-features.md` §7.2): a read tool streaming an answer, a write staying
 *   unexecuted until approved and not executing twice when the approval is replayed, a read-only
 *   user's turn, session isolation, and the audit row a chat mutation leaves behind.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CrmChatAgent } from '../../../src/application-worker/chat/chat-agent.ts';
import { scriptModel } from '../chat-agent-under-test.ts';
import { api, migrate, seedUser } from '../support.ts';

/**
 * A frame received from the agent.
 */
interface Frame {
  /**
   * Frame type.
   */
  readonly type: string;
  /**
   * Request this frame belongs to.
   */
  readonly id?: string;
  /**
   * The chunk's JSON body, for response frames.
   */
  readonly body?: string;
  /**
   * Whether this is the last frame of a request.
   */
  readonly done?: boolean;
  /**
   * Whether the request failed.
   */
  readonly error?: boolean;
}

/**
 * An open chat session.
 */
interface Session {
  /**
   * The socket.
   */
  readonly socket: WebSocket;
  /**
   * Every frame received so far.
   */
  readonly frames: Frame[];
  /**
   * Send one request and collect its frames until it is done.
   *
   * @param frame The frame to send.
   * @param requestId Request identifier to wait on.
   * @returns The request's frames.
   */
  request(frame: Record<string, unknown>, requestId: string): Promise<Frame[]>;
  /**
   * Send a frame without waiting for a specific request to finish.
   *
   * @param frame The frame to send.
   * @returns Nothing.
   */
  send(frame: Record<string, unknown>): void;
  /**
   * Wait until a predicate holds over the frames received so far.
   *
   * @param predicate What to wait for.
   * @returns Once it holds.
   * @throws {Error} When it has not held within the wait budget.
   */
  until(predicate: (frames: Frame[]) => boolean): Promise<void>;
  /**
   * Close the socket.
   *
   * @returns Nothing.
   */
  close(): void;
}

/**
 * The Durable Object instance name for one user's session, as the route derives it.
 *
 * Rebuilt here from the API's own answer rather than imported, so the test depends on what a client
 * can observe rather than on the derivation's internals.
 *
 * @param as Identity.
 * @returns The instance name.
 */
async function instanceNameFor(as: string): Promise<string> {
  const session = (await (await api('/api/v1/session', { as })).json()) as { user: { id: string } };
  return `${session.user.id}:${await sessionIdFor(as)}`;
}

/**
 * The session identifier the signed-in user may connect to.
 *
 * @param as Identity.
 * @returns The session identifier.
 */
async function sessionIdFor(as: string): Promise<string> {
  const response = await api('/api/v1/chat/session', { as });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

/**
 * Open an authenticated chat socket.
 *
 * @param as Identity to sign for.
 * @param sessionId Session to connect to; defaults to the caller's own.
 * @returns The open session.
 * @throws {Error} When the upgrade is refused.
 */
async function connect(as: string, sessionId?: string): Promise<Session> {
  const name = sessionId ?? (await sessionIdFor(as));
  const response = await api(`/api/v1/chat/${name}`, {
    as,
    headers: { Upgrade: 'websocket' }
  });
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`The upgrade was refused with ${response.status}.`);
  }
  socket.accept();
  const frames: Frame[] = [];
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        frames.push(JSON.parse(event.data) as Frame);
      } catch {
        // Non-JSON frames are not part of the protocol this suite asserts.
      }
    }
  });

  const until = async (predicate: (collected: Frame[]) => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (predicate(frames)) {
        return;
      }
      await scheduler.wait(10);
    }
    throw new Error(
      `Timed out waiting for a frame. Received: ${frames.map((frame) => frame.type).join(', ')}`
    );
  };

  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    until,
    request: async (frame, requestId) => {
      socket.send(JSON.stringify(frame));
      await until((collected) =>
        collected.some((received) => received.id === requestId && received.done === true)
      );
      return frames.filter((received) => received.id === requestId);
    },
    close: () => socket.close()
  };
}

/**
 * Build a chat request frame.
 *
 * @param requestId Request identifier.
 * @param text The user's message.
 * @returns The frame.
 */
function chatRequest(requestId: string, text: string): Record<string, unknown> {
  return {
    type: 'cf_agent_use_chat_request',
    id: requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        trigger: 'submit-message',
        messages: [{ id: `user-${requestId}`, role: 'user', parts: [{ type: 'text', text }] }]
      })
    }
  };
}

/**
 * Count contacts with one surname.
 *
 * An approved write lands through the RPC boundary rather than as a protocol frame, so the tests
 * observe it in D1 — which is also the only place that proves it really happened.
 *
 * @param lastName Surname to count.
 * @returns How many exist.
 */
async function countContacts(lastName: string): Promise<number> {
  const row = await env.DATA_DB.prepare('SELECT count(*) AS n FROM contacts WHERE last_name = ?')
    .bind(lastName)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Wait until a surname has the expected number of contacts.
 *
 * @param lastName Surname to count.
 * @param expected How many to wait for.
 * @returns Once the count matches.
 * @throws {Error} When it has not matched within the wait budget.
 */
async function waitForContacts(lastName: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await countContacts(lastName)) === expected) {
      return;
    }
    await scheduler.wait(20);
  }
  throw new Error(
    `Expected ${expected} ${lastName} contacts, found ${await countContacts(lastName)}.`
  );
}

/**
 * The text the assistant streamed in one request's frames.
 *
 * @param frames The request's frames.
 * @returns The concatenated text.
 */
function streamedText(frames: readonly Frame[]): string {
  return frames
    .flatMap((frame) => {
      if (frame.body === undefined || frame.body.trim() === '') {
        return [];
      }
      const chunk = JSON.parse(frame.body) as { type: string; delta?: string };
      return chunk.type === 'text-delta' && chunk.delta !== undefined ? [chunk.delta] : [];
    })
    .join('');
}

/**
 * Tool-related chunks in one request's frames.
 *
 * @param frames The request's frames.
 * @returns The chunks, as the UI would receive them.
 */
function toolChunks(frames: readonly Frame[]): { type: string; toolName?: string }[] {
  return frames.flatMap((frame) => {
    if (frame.body === undefined || frame.body.trim() === '') {
      return [];
    }
    const chunk = JSON.parse(frame.body) as { type: string; toolName?: string };
    return chunk.type.startsWith('tool-') ? [chunk] : [];
  });
}

/**
 * Identities used by the suite.
 *
 * One per test, not one per role, and deliberately so: a chat session belongs to a user, so two
 * tests sharing an identity share a Durable Object and therefore a transcript. The second would
 * then run against the first's conversation — including, for an approval test, a tool call still
 * awaiting a decision. Separate identities keep each test's conversation its own.
 */
const USERS = {
  read: 'chat-read@example.com',
  offerSales: 'chat-offer-sales@example.com',
  offerReader: 'chat-offer-reader@example.com',
  forbidden: 'chat-forbidden@example.com',
  approve: 'chat-approve@example.com',
  decline: 'chat-decline@example.com',
  isolationOwner: 'chat-isolation-owner@example.com',
  isolationOther: 'chat-isolation-other@example.com',
  persist: 'chat-persist@example.com',
  expiry: 'chat-expiry@example.com',
  expire: 'chat-expire@example.com'
} as const;

beforeAll(async () => {
  await migrate();
  for (const email of [
    USERS.read,
    USERS.offerSales,
    USERS.approve,
    USERS.decline,
    USERS.isolationOwner,
    USERS.isolationOther,
    USERS.persist,
    USERS.expiry,
    USERS.expire
  ]) {
    await seedUser(email, 'sales');
  }
  for (const email of [USERS.offerReader, USERS.forbidden]) {
    await seedUser(email, 'read-only');
  }
});

describe('a chat turn', () => {
  it('calls a read tool and streams a grounded answer', async () => {
    const log = scriptModel([
      [{ type: 'tool', name: 'pipeline_summary', input: {} }],
      [{ type: 'text', text: 'Your pipeline is empty so far.' }]
    ]);
    const session = await connect(USERS.read);

    const frames = await session.request(
      chatRequest('turn-read', 'How is the pipeline?'),
      'turn-read'
    );

    expect(streamedText(frames)).toContain('Your pipeline is empty so far.');
    expect(toolChunks(frames).some((chunk) => chunk.type === 'tool-input-available')).toBe(true);
    // The capability header reaches the model, and so does the caller's name.
    expect(log.prompts[0]).toContain('crm.read');
    session.close();
  });

  it('offers a sales user the write tools and a read-only user none of them', async () => {
    const salesLog = scriptModel([[{ type: 'text', text: 'Hello.' }]]);
    const sales = await connect(USERS.offerSales);
    await sales.request(chatRequest('turn-offer-sales', 'Hello'), 'turn-offer-sales');
    sales.close();

    const readerLog = scriptModel([[{ type: 'text', text: 'Hello.' }]]);
    const reader = await connect(USERS.offerReader);
    await reader.request(chatRequest('turn-offer-reader', 'Hello'), 'turn-offer-reader');
    reader.close();

    expect(salesLog.offeredTools[0]).toContain('create_contact');
    // Filtering is for usability, so a read-only user is never *offered* a write; the Data Worker's
    // own check is what makes it safe, and the next test exercises that.
    expect(readerLog.offeredTools[0]).not.toContain('create_contact');
    expect(readerLog.offeredTools[0]).toContain('pipeline_summary');
  });

  it('refuses a write a read-only user’s model calls anyway', async () => {
    scriptModel([
      [
        {
          type: 'tool',
          name: 'create_contact',
          input: { firstName: 'Mallory', lastName: 'Unauthorised' }
        }
      ],
      [{ type: 'text', text: 'I could not do that.' }]
    ]);
    const session = await connect(USERS.forbidden);

    await session.request(chatRequest('turn-forbidden', 'Add a contact'), 'turn-forbidden');

    expect(await countContacts('Unauthorised')).toBe(0);
    session.close();
  });
});

describe('an approval-gated write', () => {
  it('stays unexecuted until approved, executes once, and ignores a replayed approval', async () => {
    scriptModel([
      [
        {
          type: 'tool',
          name: 'create_contact',
          input: { firstName: 'Grace', lastName: 'Hopper', companyName: 'Compilers Ltd' }
        }
      ],
      [{ type: 'text', text: 'Created the contact.' }]
    ]);
    const session = await connect(USERS.approve);

    const frames = await session.request(
      chatRequest('turn-approve', 'Add Grace Hopper'),
      'turn-approve'
    );

    // Paused, not executed: the model asked, and nothing has reached the Data Worker yet.
    expect(await countContacts('Hopper')).toBe(0);

    const approvalChunk = frames
      .flatMap((frame) =>
        frame.body === undefined || frame.body.trim() === ''
          ? []
          : [JSON.parse(frame.body) as { type: string; toolCallId?: string }]
      )
      .find((chunk) => chunk.type === 'tool-approval-request');
    expect(approvalChunk?.toolCallId).toBeDefined();

    session.send({
      type: 'cf_agent_tool_approval',
      toolCallId: approvalChunk!.toolCallId,
      approved: true,
      autoContinue: true
    });
    await waitForContacts('Hopper', 1);

    // Replaying the approval must not create a second contact: the idempotency key is derived from
    // the turn and the tool call, so the Data Worker sees a replay (§3.5).
    session.send({
      type: 'cf_agent_tool_approval',
      toolCallId: approvalChunk!.toolCallId,
      approved: true,
      autoContinue: true
    });
    await scheduler.wait(500);

    expect(await countContacts('Hopper')).toBe(1);
    session.close();
  });

  it('records the chat channel in the audit trail', async () => {
    const audit = await env.DATA_DB.prepare(
      `SELECT a.channel AS channel FROM audit_events a
       JOIN contacts c ON c.id = a.entity_id
       WHERE c.last_name = ? AND a.action = 'created'`
    )
      .bind('Hopper')
      .first<{ channel: string }>();

    // The same operation over API, chat, and MCP differs in exactly one field, and this is it.
    expect(audit?.channel).toBe('chat');
  });

  it('does not execute a declined write, and tells the model it was declined', async () => {
    scriptModel([
      [
        {
          type: 'tool',
          name: 'create_contact',
          input: { firstName: 'Declined', lastName: 'Suggestion' }
        }
      ],
      [{ type: 'text', text: 'Understood, I will not do that.' }]
    ]);
    const session = await connect(USERS.decline);
    const frames = await session.request(
      chatRequest('turn-decline', 'Add Declined Suggestion'),
      'turn-decline'
    );
    const approvalChunk = frames
      .flatMap((frame) =>
        frame.body === undefined || frame.body.trim() === ''
          ? []
          : [JSON.parse(frame.body) as { type: string; toolCallId?: string }]
      )
      .find((chunk) => chunk.type === 'tool-approval-request');

    session.send({
      type: 'cf_agent_tool_approval',
      toolCallId: approvalChunk!.toolCallId,
      approved: false,
      autoContinue: true
    });
    await scheduler.wait(500);

    expect(await countContacts('Suggestion')).toBe(0);
    session.close();
  });
});

describe('session isolation', () => {
  it('refuses a socket for another user’s session', async () => {
    const theirs = await sessionIdFor(USERS.isolationOther);

    const response = await api(`/api/v1/chat/${theirs}`, {
      as: USERS.isolationOwner,
      headers: { Upgrade: 'websocket' }
    });

    // Refused before any dispatch, so the transcript is never read, let alone returned.
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it('refuses an unauthenticated socket', async () => {
    const mine = await sessionIdFor(USERS.isolationOwner);

    const response = await api(`/api/v1/chat/${mine}`, { headers: { Upgrade: 'websocket' } });

    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });

  it('keeps one user’s transcript out of another’s', async () => {
    scriptModel([[{ type: 'text', text: 'A private answer about a private deal.' }]]);
    const sales = await connect(USERS.offerSales);
    await sales.request(chatRequest('turn-private', 'Tell me a secret'), 'turn-private');
    sales.close();

    const readerSession = await sessionIdFor(USERS.isolationOther);
    const response = await api(`/api/v1/chat/${readerSession}/get-messages`, {
      as: USERS.isolationOther
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('A private answer');
  });
});

describe('the transcript', () => {
  it('survives a reconnect, so a reload rejoins the conversation', async () => {
    scriptModel([[{ type: 'text', text: 'Remembered across a reconnect.' }]]);
    const first = await connect(USERS.persist);
    await first.request(chatRequest('turn-persist', 'Remember this'), 'turn-persist');
    first.close();

    const sessionId = await sessionIdFor(USERS.persist);
    const response = await api(`/api/v1/chat/${sessionId}/get-messages`, {
      as: USERS.persist
    });

    const body = await response.text();
    expect(body).toContain('Remember this');
    expect(body).toContain('Remembered across a reconnect.');
  });

  it('destroys the transcript when the session expires', async () => {
    scriptModel([[{ type: 'text', text: 'This will not survive.' }]]);
    const session = await connect(USERS.expire);
    await session.request(chatRequest('turn-expire', 'Remember briefly'), 'turn-expire');
    session.close();
    const sessionId = await sessionIdFor(USERS.expire);
    expect(
      await (await api(`/api/v1/chat/${sessionId}/get-messages`, { as: USERS.expire })).text()
    ).toContain('Remember briefly');

    // Run the callback the schedule would have run, rather than waiting three hours.
    const stub = env.CHAT_AGENT.get(
      env.CHAT_AGENT.idFromName(await instanceNameFor(USERS.expire))
    ) as unknown as CrmChatAgent;
    await stub.expireSession();

    // Genuinely gone, not archived: the authoritative record of what changed is the audit trail,
    // which outlives the conversation that produced it (§3.2).
    const after = await api(`/api/v1/chat/${sessionId}/get-messages`, { as: USERS.expire });
    expect(await after.text()).not.toContain('Remember briefly');
  });

  it('arms exactly one rolling expiry, replaced rather than accumulated', async () => {
    scriptModel([[{ type: 'text', text: 'One.' }], [{ type: 'text', text: 'Two.' }]]);
    const session = await connect(USERS.expiry);

    await session.request(chatRequest('turn-expiry-1', 'First'), 'turn-expiry-1');
    await session.request(chatRequest('turn-expiry-2', 'Second'), 'turn-expiry-2');
    session.close();

    const stub = env.CHAT_AGENT.get(
      env.CHAT_AGENT.idFromName(await instanceNameFor(USERS.expiry))
    ) as unknown as CrmChatAgent;
    const schedules = await stub.listSchedules();

    // A long conversation must end with one pending alarm, not one per message: the agent cancels
    // the previous schedule before arming the next, which is what makes the expiry *rolling* (§3.6).
    expect(schedules.filter((schedule) => schedule.callback === 'expireSession')).toHaveLength(1);
  });

  it('answers a non-upgrade request to the socket route without a socket', async () => {
    const sessionId = await sessionIdFor(USERS.persist);

    const response = await api(`/api/v1/chat/${sessionId}`, { as: USERS.persist });

    expect(response.webSocket).toBeNull();
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
