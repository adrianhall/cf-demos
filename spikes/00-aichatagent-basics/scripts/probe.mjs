#!/usr/bin/env node
/**
 * @file Spike A's live probe against the deployed `spike-00-aichatagent-basics` Worker.
 *
 * Speaks the `AIChatAgent` wire protocol directly (reverse-engineered from the installed
 * `agents`/`@cloudflare/ai-chat` package source — `agents/chat`'s `parseProtocolMessage()` and
 * `CHAT_MESSAGE_TYPES` — rather than through `agents/react`'s `useAgentChat`, since that hook is
 * React-only and this demo is Vue-only, Section 6.2a) using the `ws` package instead of
 * `agents/client`'s `AgentClient` only because a plain `WebSocket` (browser or Node's built-in)
 * cannot set a custom upgrade header, and this probe needs one to stand in for a Cloudflare
 * Access-verified identity (see src/index.ts's `ChatAgentProps` JSDoc). `AgentClient` itself was
 * separately confirmed framework-agnostic by reading its shipped source (it extends `PartySocket`
 * extends `ReconnectingWebSocket` — no React import anywhere in that chain); this probe's own
 * frames are wire-compatible with what `AgentClient` would carry.
 *
 * Usage:
 *   node scripts/probe.mjs --host <worker-host> --model reasoning|non-reasoning \
 *     [--chat <chat-id>] [--owner <email>] [--message "..."]
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

function parseArgs() {
  const args = { model: "non-reasoning" };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    args[key] = process.argv[i + 1];
  }
  return args;
}

const args = parseArgs();
const host = args.host ?? process.env.SPIKE_HOST;
if (!host) {
  console.error("Usage: probe.mjs --host <worker-host> [--model reasoning|non-reasoning] ...");
  process.exit(1);
}
const chatId = args.chat ?? randomUUID();
const owner = args.owner ?? "spike-probe@example.com";
const message =
  args.message ??
  "In one short sentence, what email owns this chat? Answer with just the email.";

const url = `wss://${host}/chat/${chatId}?model=${args.model}`;
console.log(`[probe] connecting to ${url} (owner header: ${owner})`);

const ws = new WebSocket(url, { headers: { "X-Spike-Owner": owner } });

/** Wire message-type constants, confirmed from `agents/dist/wire-types-*.js` (Section: Report). */
const USE_CHAT_REQUEST = "cf_agent_use_chat_request";
const USE_CHAT_RESPONSE = "cf_agent_use_chat_response";

const requestId = randomUUID();
/** @type {string[]} Raw SSE body chunks, concatenated in arrival order. */
const bodyChunks = [];
/** @type {Set<string>} Every distinct UI-message-stream part `type` observed. */
const observedPartTypes = new Set();

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
      // The wire body is NOT classic `data: {...}` SSE framing — it is the raw
      // `toUIMessageStreamResponse()` body text forwarded byte-for-byte (bare, newline-adjacent
      // JSON objects with no "data:" prefix; see REPORT.md). Extract every `"type":"..."` this
      // chunk carries directly rather than assuming an SSE line shape.
      for (const match of parsed.body.matchAll(/"type":"([a-z0-9-]+)"/g)) {
        observedPartTypes.add(match[1]);
      }
    }
    if (parsed.done) {
      const fullText = bodyChunks.join("");
      console.log("\n[probe] === stream complete ===");
      console.log(`[probe] distinct UI-message-stream part types: ${[...observedPartTypes].join(", ")}`);
      console.log(`[probe] raw SSE body (${fullText.length} chars):\n${fullText}`);
      ws.close(1000, "probe complete");
    }
    return;
  }

  console.log("[probe] other frame:", JSON.stringify(parsed).slice(0, 300));
});

ws.on("error", (err) => {
  console.error("[probe] error:", err.message);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log(`[probe] closed: ${code} ${reason}`);
});
