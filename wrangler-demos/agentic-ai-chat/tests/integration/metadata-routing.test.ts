import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  type CapturedAiCall,
  createChat,
  createCapturingFakeAi,
  ensureSignedIn,
  openChatSocket,
  sendTurn,
  withFakeAi,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A verified-identity email unique to one test, mirroring every other integration test file's
 * own per-test-file storage-isolation convention. */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Set an identity's business segment through the real admin `PATCH` route, mirroring
 * `tests/integration/admin.test.ts`'s own pattern. Always sends `geo: null` alongside, since
 * that route requires both fields together (Phase 7).
 *
 * @param email The identity to set.
 * @param business The business segment to assign, or `null` to clear it.
 */
async function setBusiness(
  email: string,
  business: string | null,
): Promise<void> {
  const adminEmail = (env as TestEnv).ADMIN_EMAIL;
  await ensureSignedIn(adminEmail);
  await ensureSignedIn(email);
  const response = await authenticatedRequest(
    `/api/admin/users/${encodeURIComponent(email)}`,
    {
      body: JSON.stringify({ business, geo: null }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
    adminEmail,
  );
  if (response.status !== 200) {
    throw new Error(
      `Fixture failed to set business for ${email}: HTTP ${response.status}`,
    );
  }
}

/**
 * Send one turn on `owner`'s chat through a fresh chat + WebSocket connection and return what
 * the fake `Ai` binding observed about the call `ChatAgent` made.
 *
 * @param owner Verified identity to open the chat and connection as.
 * @param openSockets The calling test's own socket-tracking set, for `afterEach` teardown.
 * @returns The captured call, guaranteed non-`undefined` by this helper's own assertion.
 */
async function captureTurn(
  owner: string,
  openSockets: Set<WebSocket>,
): Promise<CapturedAiCall> {
  const chatId = await createChat(owner);
  const capture: { call?: CapturedAiCall } = {};
  await withFakeAi(
    createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
    async () => {
      const socket = await openChatSocket(chatId, openSockets, owner);
      await sendTurn(socket, "hi");
    },
  );
  if (capture.call === undefined) {
    throw new Error("Fixture never observed a captured env.AI.run() call.");
  }
  return capture.call;
}

/**
 * Exercises Phase 8's metadata-driven model routing (US-7, docs/06-AGENTIC-CHAT.md): the
 * caller's admin-assigned `business` segment is attached to every chat turn as AI Gateway
 * request metadata, read fresh from D1 on every request -- never from anything the client's own
 * message body could set -- so AI Gateway's own conditional model-node branching
 * (`infra/agentic-ai-chat.tf`'s `business-check` element on both routes) can steer different
 * segments to different underlying models with zero client-side branching.
 *
 * Every test here substitutes a fake `env.AI` binding and asserts on the exact
 * `gateway.metadata` object `ChatAgent` calls it with, rather than making a real call against a
 * live AI Gateway -- the same "fake gateway double" testing convention
 * `tests/integration/dynamic-routes.test.ts` already established for Phase 4, and explicitly
 * sanctioned by this phase's own plan text for exactly this reason (docs/06-AGENTIC-CHAT.md
 * Phase 8's Testing section). Whether AI Gateway's own conditional node actually resolves two
 * different `business` values to two different models was already confirmed live by Spike B
 * (`spikes/01-ai-gateway-dynamic-routing/REPORT.md` Section 3) and is not re-proven here; this
 * suite instead proves the one thing under this Worker's own control: that the correct,
 * D1-sourced `business` value reaches AI Gateway as metadata for the correct caller, every time.
 */
describe("Metadata-driven model routing (US-7)", () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("attaches the signed-in owner's own admin-assigned business as gateway metadata", async () => {
    const owner = uniqueEmail("field-business");
    await setBusiness(owner, "field");

    const call = await captureTurn(owner, openSockets);

    expect(call.metadata).toMatchObject({ business: "field" });
    expect(typeof call.metadata?.correlationId).toBe("string");
  }, 15_000);

  it("attaches null business metadata for a caller with no business assigned yet", async () => {
    const owner = uniqueEmail("unset-business");
    await ensureSignedIn(owner);

    const call = await captureTurn(owner, openSockets);

    expect(call.metadata).toMatchObject({ business: null });
  }, 15_000);

  it("attaches two different callers' own business values, never mixing them up", async () => {
    const fieldOwner = uniqueEmail("field-caller");
    const leadershipOwner = uniqueEmail("leadership-caller");
    await setBusiness(fieldOwner, "field");
    await setBusiness(leadershipOwner, "leadership");

    const fieldCall = await captureTurn(fieldOwner, openSockets);
    const leadershipCall = await captureTurn(leadershipOwner, openSockets);

    expect(fieldCall.metadata).toMatchObject({ business: "field" });
    expect(leadershipCall.metadata).toMatchObject({ business: "leadership" });
    // Both callers submit the exact same "basic" route selection -- the only difference AI
    // Gateway's own conditional node has to steer on is this metadata, never the model id
    // string itself (Section 6.3's "zero client-side branching" requirement).
    expect(fieldCall.modelId).toBe(leadershipCall.modelId);
  }, 20_000);

  it("re-reads business fresh from D1 on every request, never caching a chat's owner's segment at creation time", async () => {
    const owner = uniqueEmail("business-changes-after-creation");
    await ensureSignedIn(owner);
    const chatId = await createChat(owner);

    // Only *after* the chat already exists does an admin assign a business segment --
    // `ownedAgentStub()` must still pick this up on the very next turn (docs/06-AGENTIC-CHAT.md
    // Phase 8's "re-read alongside route, on every request" design), not whatever was true when
    // the chat was first created.
    await setBusiness(owner, "product");

    const capture: { call?: CapturedAiCall } = {};
    await withFakeAi(
      createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    expect(capture.call?.metadata).toMatchObject({ business: "product" });
  }, 15_000);
});
