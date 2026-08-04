import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ALLOWED_HOSTS } from "../../src/worker/egress/allowlist";
import {
  ALICE,
  createChat,
  createSequencedFakeAi,
  getUrlToolCallPayloads,
  openChatSocket,
  sendTurn,
  withFakeAi,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const [allowedHost] = ALLOWED_HOSTS;

/**
 * Exercises the `getUrl` tool end to end (docs/06-AGENTIC-CHAT.md Phase 10, US-9): a fake model
 * scripted to call the tool, driving the real chain (tool -> Dynamic Worker -> `EgressGateway`
 * -> real `fetch()`) through a real `ChatAgent` Durable Object -- following the
 * `testing-durable-objects` skill's lifecycle rules, exactly like `files.test.ts` does for
 * `writeMarkdown`.
 *
 * The allow-listed case necessarily touches the real Internet (this file's own `wrangler.jsonc`
 * declares a real `worker_loaders` binding with no local/remote toggle at all -- Spike C's own
 * finding that this primitive has no account-level proxy step to fake), mirroring
 * `dynamic-routes.test.ts`'s own documented real-account touch-point for a different mechanism;
 * `README.md`'s testing section documents this. The blocked case, by contrast, never reaches the
 * network at all -- `EgressGateway` denies it before any real `fetch()` call happens.
 */
describe("getUrl tool (US-9)", () => {
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

  it("fetches an allow-listed URL for real and lets the model reference its content", async () => {
    const chatId = await createChat(ALICE);
    const url = `https://${allowedHost}/`;
    const fakeAi = createSequencedFakeAi([
      getUrlToolCallPayloads(url),
      ['{"response":"Fetched it successfully."}', "[DONE]"],
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, `Please fetch ${url} and tell me if it worked.`);
    });

    expect(rawBody).toContain('"type":"tool-input-available"');
    expect(rawBody).toContain('"toolName":"getUrl"');
    expect(rawBody).toContain('"type":"tool-output-available"');
    expect(rawBody).toContain('"success":true');
    expect(rawBody).not.toContain('"blocked"');
    expect(rawBody).toContain("Fetched it successfully.");
  }, 20_000);

  it("blocks a non-allow-listed URL before it reaches the network and completes the turn with an explanation", async () => {
    const chatId = await createChat(ALICE);
    const url = "https://cloudflare.com/";
    const fakeAi = createSequencedFakeAi([
      getUrlToolCallPayloads(url),
      [
        '{"response":"That destination is not allowed by this demo\'s egress policy."}',
        "[DONE]",
      ],
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, `Please fetch ${url}.`);
    });

    expect(rawBody).toContain('"type":"tool-output-available"');
    expect(rawBody).toContain('"success":false');
    expect(rawBody).toContain('"blocked":true');
    expect(rawBody).toContain("cloudflare.com");
    expect(rawBody).toContain("not allowed by this demo's egress policy");
  }, 15_000);

  it("rejects an obviously-internal address before ever loading the Dynamic Worker", async () => {
    const chatId = await createChat(ALICE);
    const url = "http://127.0.0.1/";
    const fakeAi = createSequencedFakeAi([
      getUrlToolCallPayloads(url),
      ['{"response":"I cannot fetch an internal address."}', "[DONE]"],
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, `Please fetch ${url}.`);
    });

    expect(rawBody).toContain('"success":false');
    expect(rawBody).toContain('"blocked":false');
    expect(rawBody).toContain("internal address");
    expect(rawBody).toContain("I cannot fetch an internal address.");
  }, 15_000);
});
