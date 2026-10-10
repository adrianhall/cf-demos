import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildSkillRegistry } from "../../src/worker/skills/registry";
import {
  activateSkillToolCallPayloads,
  ALICE,
  authenticatedRequest,
  BOB,
  createChat,
  createSequencedFakeAi,
  ensureSignedIn,
  openChatSocket,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
  withFakeFetch,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** One row of `GET /api/skills`/`GET /api/admin/skills`'s response. */
interface SkillJson {
  id: string;
  ownerEmail: string | null;
  name: string;
  sourceType: string;
  sourceRef: string | null;
}

/** Create a personal skill through the real `POST /api/skills` route.
 *
 * @param email Verified identity creating the skill.
 * @param name The skill's display name.
 * @param content The skill's raw instruction body (an upload source).
 * @returns The created skill's own JSON representation.
 */
async function createPersonalSkill(
  email: string,
  name: string,
  content: string,
): Promise<SkillJson> {
  const response = await authenticatedRequest(
    "/api/skills",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "A test skill.",
        source: { type: "upload", content },
      }),
    },
    email,
  );
  if (response.status !== 201) {
    throw new Error(
      `Fixture failed to create a personal skill: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { skill: SkillJson };
  return body.skill;
}

/** Create an enterprise skill through the real `POST /api/admin/skills` route.
 *
 * @param adminEmail A verified identity holding this demo's administrator role.
 * @param name The skill's display name.
 * @param content The skill's raw instruction body (an upload source).
 * @returns The created skill's own JSON representation.
 */
async function createEnterpriseSkill(
  adminEmail: string,
  name: string,
  content: string,
): Promise<SkillJson> {
  const response = await authenticatedRequest(
    "/api/admin/skills",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "A test enterprise skill.",
        source: { type: "upload", content },
      }),
    },
    adminEmail,
  );
  if (response.status !== 201) {
    throw new Error(
      `Fixture failed to create an enterprise skill: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { skill: SkillJson };
  return body.skill;
}

/** Build a unique, per-test skill/identity name so this file's shared D1/R2 state (this pool
 * evicts storage per test *file*, not per test -- mirrors `admin.test.ts`'s own rationale) can
 * never collide between test cases. */
function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Exercises Phase 11's personal/enterprise skills (US-10, docs/06-AGENTIC-CHAT.md): the
 * `/api/skills`/`/api/admin/skills` CRUD routes, per-owner R2 isolation, `buildSkillRegistry()`'s
 * own catalog composition (enterprise ∪ own personal, never another user's personal -- the
 * mechanism `../../src/worker/agent/chat-agent.ts`'s `getSkillRegistry()` actually calls), and a
 * full turn activating a seeded skill through a real `ChatAgent` Durable Object.
 *
 * `buildSkillRegistry()` is exercised directly here, not only indirectly through a chat turn,
 * because `agents/skills`'s `r2()` source needs a real R2 binding (`env.FILES`) to list/read
 * objects -- the exact reason this demo's other R2-backed application code
 * (`../../src/worker/files/storage.ts`) is likewise only ever integration-tested, never unit-
 * tested with a mocked bucket for its actual listing behavior.
 */
describe("Personal and enterprise skills (US-10)", () => {
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

  describe("route authorization", () => {
    it("rejects an unauthenticated request to every personal/enterprise skill route", async () => {
      const responses = await Promise.all([
        unauthenticatedRequest("/api/skills"),
        unauthenticatedRequest("/api/skills", { method: "POST" }),
        unauthenticatedRequest(`/api/skills/${crypto.randomUUID()}`, {
          method: "DELETE",
        }),
        unauthenticatedRequest("/api/admin/skills"),
        unauthenticatedRequest("/api/admin/skills", { method: "POST" }),
        unauthenticatedRequest(`/api/admin/skills/${crypto.randomUUID()}`, {
          method: "DELETE",
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });

    it("rejects a signed-in, non-administrator identity with 403 from every enterprise-skill route", async () => {
      const nonAdmin = unique("non-admin");
      await ensureSignedIn(nonAdmin);

      const responses = await Promise.all([
        authenticatedRequest("/api/admin/skills", {}, nonAdmin),
        authenticatedRequest(
          "/api/admin/skills",
          { method: "POST", body: "{}" },
          nonAdmin,
        ),
        authenticatedRequest(
          `/api/admin/skills/${crypto.randomUUID()}`,
          { method: "DELETE" },
          nonAdmin,
        ),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(403);
      }
    });
  });

  describe("personal skill CRUD and isolation", () => {
    it("lists only the caller's own personal skills, never another user's", async () => {
      const alice = unique("alice");
      const bob = unique("bob");
      await createPersonalSkill(
        alice,
        unique("alice-skill"),
        "Alice's own instructions.",
      );
      await createPersonalSkill(
        bob,
        unique("bob-skill"),
        "Bob's own instructions.",
      );

      const aliceResponse = await authenticatedRequest(
        "/api/skills",
        {},
        alice,
      );
      const bobResponse = await authenticatedRequest("/api/skills", {}, bob);

      const aliceBody = (await aliceResponse.json()) as { skills: SkillJson[] };
      const bobBody = (await bobResponse.json()) as { skills: SkillJson[] };
      expect(aliceBody.skills).toHaveLength(1);
      expect(bobBody.skills).toHaveLength(1);
      expect(aliceBody.skills[0]?.ownerEmail).toBe(alice);
      expect(bobBody.skills[0]?.ownerEmail).toBe(bob);
    });

    it("rejects a duplicate personal skill name within the same owner's scope with 422", async () => {
      const alice = unique("alice");
      const name = unique("brand-voice");
      await createPersonalSkill(alice, name, "First version.");

      const response = await authenticatedRequest(
        "/api/skills",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            description: "A test skill.",
            source: { type: "upload", content: "Second version." },
          }),
        },
        alice,
      );

      expect(response.status).toBe(422);
    });

    it("allows the same skill name for two different owners (scoped per owner)", async () => {
      const alice = unique("alice");
      const bob = unique("bob");
      const name = unique("shared-name");

      const aliceResponse = await authenticatedRequest(
        "/api/skills",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            description: "Alice's version.",
            source: { type: "upload", content: "Alice's content." },
          }),
        },
        alice,
      );
      const bobResponse = await authenticatedRequest(
        "/api/skills",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            description: "Bob's version.",
            source: { type: "upload", content: "Bob's content." },
          }),
        },
        bob,
      );

      expect(aliceResponse.status).toBe(201);
      expect(bobResponse.status).toBe(201);
    });

    it("deletes only the owner's own personal skill and removes its backing R2 object", async () => {
      const alice = unique("alice");
      const skill = await createPersonalSkill(
        alice,
        unique("deletable"),
        "Delete me.",
      );

      const deleteResponse = await authenticatedRequest(
        `/api/skills/${skill.id}`,
        { method: "DELETE" },
        alice,
      );
      expect(deleteResponse.status).toBe(204);

      const listResponse = await authenticatedRequest("/api/skills", {}, alice);
      const listBody = (await listResponse.json()) as { skills: SkillJson[] };
      expect(
        listBody.skills.find((entry) => entry.id === skill.id),
      ).toBeUndefined();

      const remaining = await env.FILES.list({
        prefix: `skills/personal/${alice}/${skill.id}/`,
      });
      expect(remaining.objects).toHaveLength(0);
    });

    it("returns 404 deleting a personal skill that belongs to a different owner", async () => {
      const alice = unique("alice");
      const bob = unique("bob");
      const skill = await createPersonalSkill(
        alice,
        unique("alices-own"),
        "Alice's own instructions.",
      );

      const response = await authenticatedRequest(
        `/api/skills/${skill.id}`,
        { method: "DELETE" },
        bob,
      );

      expect(response.status).toBe(404);
      const listResponse = await authenticatedRequest("/api/skills", {}, alice);
      const listBody = (await listResponse.json()) as { skills: SkillJson[] };
      expect(
        listBody.skills.find((entry) => entry.id === skill.id),
      ).toBeDefined();
    });

    it("returns 404 deleting a personal skill id that was never created", async () => {
      const alice = unique("alice");
      await ensureSignedIn(alice);

      const response = await authenticatedRequest(
        `/api/skills/${crypto.randomUUID()}`,
        { method: "DELETE" },
        alice,
      );

      expect(response.status).toBe(404);
    });

    it("creates a URL-sourced personal skill by fetching the URL server-side", async () => {
      const alice = unique("alice");
      const url = "https://example.com/skill.md";

      const response = await withFakeFetch(
        // biome-ignore lint/suspicious/noExplicitAny: a minimal fetch double matching only what fetchSkillSourceBody calls.
        (async () => new Response("# Remote instructions")) as any,
        () =>
          authenticatedRequest(
            "/api/skills",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: unique("remote-skill"),
                description: "Fetched from a URL.",
                source: { type: "url", url },
              }),
            },
            alice,
          ),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { skill: SkillJson };
      expect(body.skill).toMatchObject({ sourceType: "url", sourceRef: url });
    });
  });

  describe("enterprise skill CRUD, visible to everyone", () => {
    it("lists an enterprise skill in every signed-in identity's admin view", async () => {
      const adminEmail = (env as TestEnv).ADMIN_EMAIL;
      await ensureSignedIn(adminEmail);
      const skill = await createEnterpriseSkill(
        adminEmail,
        unique("enterprise-skill"),
        "Shared instructions.",
      );

      const response = await authenticatedRequest(
        "/api/admin/skills",
        {},
        adminEmail,
      );
      const body = (await response.json()) as { skills: SkillJson[] };

      expect(body.skills.find((entry) => entry.id === skill.id)).toMatchObject({
        ownerEmail: null,
      });
    });

    it("deletes an enterprise skill and removes its backing R2 object", async () => {
      const adminEmail = (env as TestEnv).ADMIN_EMAIL;
      await ensureSignedIn(adminEmail);
      const skill = await createEnterpriseSkill(
        adminEmail,
        unique("deletable-enterprise"),
        "Delete me.",
      );

      const deleteResponse = await authenticatedRequest(
        `/api/admin/skills/${skill.id}`,
        { method: "DELETE" },
        adminEmail,
      );
      expect(deleteResponse.status).toBe(204);

      const remaining = await env.FILES.list({
        prefix: `skills/enterprise/${skill.id}/`,
      });
      expect(remaining.objects).toHaveLength(0);
    });

    it("returns 404 deleting an enterprise skill id that was never created", async () => {
      const adminEmail = (env as TestEnv).ADMIN_EMAIL;
      await ensureSignedIn(adminEmail);

      const response = await authenticatedRequest(
        `/api/admin/skills/${crypto.randomUUID()}`,
        { method: "DELETE" },
        adminEmail,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("buildSkillRegistry() catalog composition -- the exact mechanism ChatAgent uses", () => {
    it("composes enterprise skills with the caller's own personal skills, never another user's", async () => {
      const adminEmail = (env as TestEnv).ADMIN_EMAIL;
      await ensureSignedIn(adminEmail);
      const alice = unique("alice");
      const bob = unique("bob");
      const enterpriseName = unique("enterprise-skill");
      const aliceSkillName = unique("alice-only-skill");
      const bobSkillName = unique("bob-only-skill");
      await createEnterpriseSkill(
        adminEmail,
        enterpriseName,
        "Enterprise instructions.",
      );
      await createPersonalSkill(
        alice,
        aliceSkillName,
        "Alice's own instructions.",
      );
      await createPersonalSkill(bob, bobSkillName, "Bob's own instructions.");

      const aliceRegistry = buildSkillRegistry(env.FILES, alice);
      const aliceNames = (await aliceRegistry.snapshot()).catalogPrompt ?? "";
      expect(aliceNames).toContain(enterpriseName);
      expect(aliceNames).toContain(aliceSkillName);
      expect(aliceNames).not.toContain(bobSkillName);

      const bobRegistry = buildSkillRegistry(env.FILES, bob);
      const bobNames = (await bobRegistry.snapshot()).catalogPrompt ?? "";
      expect(bobNames).toContain(enterpriseName);
      expect(bobNames).toContain(bobSkillName);
      expect(bobNames).not.toContain(aliceSkillName);
    });

    it("includes only enterprise skills when no owner is known (a wake with no props)", async () => {
      const adminEmail = (env as TestEnv).ADMIN_EMAIL;
      await ensureSignedIn(adminEmail);
      const alice = unique("alice");
      const enterpriseName = unique("enterprise-skill");
      const aliceSkillName = unique("alice-only-skill");
      await createEnterpriseSkill(
        adminEmail,
        enterpriseName,
        "Enterprise instructions.",
      );
      await createPersonalSkill(
        alice,
        aliceSkillName,
        "Alice's own instructions.",
      );

      const registry = buildSkillRegistry(env.FILES, undefined);
      const catalog = (await registry.snapshot()).catalogPrompt ?? "";

      expect(catalog).toContain(enterpriseName);
      expect(catalog).not.toContain(aliceSkillName);
    });

    it("never includes a personal skill for an owner who has added none", async () => {
      const freshOwner = unique("fresh-owner");
      const otherOwnerSkillName = unique("someone-elses-skill");
      await createPersonalSkill(
        unique("someone-else"),
        otherOwnerSkillName,
        "Not this owner's skill.",
      );

      const registry = buildSkillRegistry(env.FILES, freshOwner);
      const catalog = (await registry.snapshot()).catalogPrompt ?? "";

      expect(catalog).not.toContain(otherOwnerSkillName);
    });
  });

  describe("a real turn activating a seeded skill (end to end)", () => {
    it("activates a seeded personal skill and reads its real R2-stored content through the tool chain", async () => {
      const chatId = await createChat(ALICE);
      const skillName = unique("cloudflare-spike-fact");
      await createPersonalSkill(
        ALICE,
        skillName,
        "The spike passphrase is TURQUOISE-NARWHAL-77.",
      );
      const fakeAi = createSequencedFakeAi([
        activateSkillToolCallPayloads(skillName),
        ['{"response":"The passphrase is TURQUOISE-NARWHAL-77."}', "[DONE]"],
      ]);

      const rawBody = await withFakeAi(fakeAi, async () => {
        const socket = await openChatSocket(chatId, openSockets, ALICE);
        return sendTurn(socket, "What is the spike passphrase?");
      });

      expect(rawBody).toContain('"type":"tool-input-available"');
      expect(rawBody).toContain('"toolName":"activate_skill"');
      expect(rawBody).toContain('"type":"tool-output-available"');
      // The tool's own result wraps the *real* R2-stored skill body -- proving this reached the
      // genuine `agents/skills` R2 source, not a stubbed/mocked tool result.
      expect(rawBody).toContain("TURQUOISE-NARWHAL-77");
      expect(rawBody).toContain("The passphrase is TURQUOISE-NARWHAL-77.");
    }, 20_000);

    it("completes an unrelated turn normally when the chat has no seeded skill at all", async () => {
      const chatId = await createChat(BOB);
      const fakeAi = createSequencedFakeAi([
        ['{"response":"12 \\u00d7 7 = 84."}', "[DONE]"],
      ]);

      const rawBody = await withFakeAi(fakeAi, async () => {
        const socket = await openChatSocket(chatId, openSockets, BOB);
        return sendTurn(socket, "What is 12 times 7?");
      });

      expect(rawBody).not.toContain('"toolName":"activate_skill"');
      expect(rawBody).toContain("84");
    }, 20_000);
  });
});
