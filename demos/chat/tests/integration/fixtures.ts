import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";

/** Verified identity used by default when a test does not care which participant acts. */
export const ALICE = "alice@example.com";

/** A second verified identity, used wherever a test must prove no admin role exists. */
export const BOB = "bob@example.com";

/**
 * Reset the D1 channel directory to the same two seeded rows the real migration creates, so
 * every test starts from identical, known state regardless of execution order.
 *
 * @returns Promise resolved once the directory has been reset.
 */
export async function resetChannelDirectory(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS channels"),
    env.DB.prepare(`
      CREATE TABLE channels (
        name TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(
      "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)",
    ).bind("general", "system", "2026-07-27T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)",
    ).bind("random", "system", "2026-07-27T00:00:00.000Z"),
  ]);
}

/**
 * Send one request through the real Worker as a verified Cloudflare Access identity.
 *
 * @param path Request path beginning with `/`.
 * @param init Ordinary `fetch` request options.
 * @param email Verified identity to sign a development Access token for.
 * @returns The Worker's response.
 */
export async function authenticatedRequest(
  path: string,
  init: RequestInit = {},
  email: string = ALICE,
): Promise<Response> {
  const token = await signDevJwt(email);
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  return exports.default.fetch(
    new Request(`https://chat.example${path}`, { ...init, headers }),
  );
}

/**
 * Add one channel to the directory through the real `/api/channels` route, matching how a
 * participant creates a channel in production, so integration tests never insert directory
 * rows directly.
 *
 * @param name Channel name to create.
 * @param email Verified identity creating the channel.
 * @throws {Error} When the creation request does not succeed, so a broken fixture fails fast
 *   at the call site instead of surfacing as a confusing later assertion failure.
 */
export async function createChannel(
  name: string,
  email: string = ALICE,
): Promise<void> {
  const response = await authenticatedRequest(
    "/api/channels",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    email,
  );
  if (response.status !== 201) {
    throw new Error(
      `Fixture failed to create channel "${name}": HTTP ${response.status}`,
    );
  }
}

/**
 * @returns A channel name unique to one test, so Durable Object storage never leaks across
 *   tests. Truncated to fit the 32-character channel name limit enforced by
 *   `validateChannelName`.
 */
export function uniqueChannelName(): string {
  return `test-${crypto.randomUUID().slice(0, 8)}`;
}
