#!/usr/bin/env node
/**
 * @file Spike D's live probe against the deployed `spike-03-agent-skills-composability` Worker.
 *
 * Speaks the `AIChatAgent` wire protocol directly, exactly as Spike A's `probe.mjs` does (see that
 * script's own header comment for why: the wire protocol is reverse-engineered from the installed
 * `agents`/`@cloudflare/ai-chat` package source, and `agents/client`'s `AgentClient` — the only
 * framework-agnostic client — cannot set the custom identity-stand-in header this probe needs, so
 * a plain `ws` WebSocket is used instead). Reused verbatim rather than re-decided here.
 *
 * Usage:
 *   node scripts/probe.mjs --host <worker-host> [--chat <chat-id>] [--owner <email>]
 *     [--message "..."]
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    args[key] = process.argv[i + 1];
  }
  return args;
}

const args = parseArgs();
const host = args.host ?? process.env.SPIKE_HOST;
if (!host) {
  console.error("Usage: probe.mjs --host <worker-host> [--chat <id>] [--owner <email>] [--message \"...\"]");
  process.exit(1);
}
const chatId = args.chat ?? randomUUID();
const owner = args.owner ?? "spike-probe@example.com";
const message = args.message ?? "What is the spike passphrase?";

const url = `wss://${host}/chat/${chatId}`;
console.log(`[probe] connecting to ${url} (chat=${chatId}, owner header: ${owner})`);
console.log(`[probe] message: ${JSON.stringify(message)}`);

const ws = new WebSocket(url, { headers: { "X-Spike-Owner": owner } });

/** Wire message-type constants, confirmed live by Spike A (docs/DECISIONS.md #11). */
const USE_CHAT_REQUEST = "cf_agent_use_chat_request";
const USE_CHAT_RESPONSE = "cf_agent_use_chat_response";

const requestId = randomUUID();
/** @type {string[]} Raw stream body chunks, concatenated in arrival order. */
const bodyChunks = [];
/** @type {Set<string>} Every distinct UI-message-stream part `type` observed. */
const observedPartTypes = new Set();

// Guards against a hung connection (for example a `streamText()` call that never resolves)
// leaving this probe running indefinitely in an automated context.
const timeout = setTimeout(() => {
  console.error("[probe] timed out waiting for stream completion");
  ws.close();
  process.exit(1);
}, 60_000);

ws.on("open", () => {
  console.log("[probe] connection open, sending chat-request frame");
  const frame = {
    type: USE_CHAT_REQUEST,
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: message }],
          },
        ],
        trigger: "submit-message",
      }),
    },
  };
  ws.send(JSON.stringify(frame));
});

ws.on("message", (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    console.log("[probe] non-JSON frame:", raw.toString().slice(0, 200));
    return;
  }

  if (parsed.type === "cf_agent_identity") {
    console.log(`[probe] identity: agent=${parsed.agent} name=${parsed.name}`);
    return;
  }

  if (parsed.type === USE_CHAT_RESPONSE && parsed.id === requestId) {
    if (parsed.body) {
      bodyChunks.push(parsed.body);
      // The wire body is bare, back-to-back JSON objects (Spike A's finding, docs/DECISIONS.md
      // #11), not classic `data: {...}` SSE framing. Extract every `"type":"..."` this chunk
      // carries directly. Tool-related part types (`tool-activate_skill`,
      // `tool-read_skill_resource`) contain underscores, unlike Spike A's plain text/step types,
      // so the character class here is widened from Spike A's `[a-z0-9-]+` to include `_`.
      for (const match of parsed.body.matchAll(/"type":"([a-z0-9_-]+)"/g)) {
        observedPartTypes.add(match[1]);
      }
    }
    if (parsed.done) {
      clearTimeout(timeout);
      const fullText = bodyChunks.join("");
      console.log("\n[probe] === stream complete ===");
      console.log(`[probe] distinct UI-message-stream part types: ${[...observedPartTypes].join(", ")}`);
      console.log(`[probe] raw body (${fullText.length} chars):\n${fullText}`);
      ws.close(1000, "probe complete");
    }
    return;
  }

  console.log("[probe] other frame:", JSON.stringify(parsed).slice(0, 300));
});

ws.on("error", (err) => {
  clearTimeout(timeout);
  console.error("[probe] error:", err.message);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  clearTimeout(timeout);
  console.log(`[probe] closed: ${code} ${reason}`);
});
