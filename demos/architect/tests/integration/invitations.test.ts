/** @file Phase 3 integration coverage: invitation lifecycle, redemption, and membership widening. */
import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Test-only D1 migrations binding injected by `tests/integration/vitest.config.ts`. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A diagram, as returned by the diagrams API. */
interface DiagramResponse {
  id: string;
  ownerEmail: string;
  title: string;
}

/** An invitation, as returned by the invitation-management API. */
interface InvitationResponse {
  id: string;
  diagramId: string;
  creatorEmail: string;
  expiresAt: string;
}

/** Build and send an authenticated request against the real Worker, matching production shape. */
async function authenticatedRequest(
  path: string,
  options: {
    body?: unknown;
    email?: string;
    method?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const {
    body,
    email = "owner@example.com",
    method = "GET",
    origin = "http://example.test",
  } = options;
  const token = await signDevJwt(email);
  const headers = new Headers({ [JWT_HEADER]: token });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("origin", origin);
  }
  return exports.default.fetch(
    new Request(`http://example.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  );
}

/** Create a diagram and return its directory record. */
async function createDiagram(
  title: string,
  email: string,
): Promise<DiagramResponse> {
  const response = await authenticatedRequest("/api/diagrams", {
    body: { title },
    email,
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { diagram: DiagramResponse };
  return body.diagram;
}

/** Create an invitation for a diagram as its owner, returning the summary and one-time token. */
async function createInvitation(
  diagramId: string,
  ownerEmail: string,
): Promise<{ invitation: InvitationResponse; token: string }> {
  const response = await authenticatedRequest(
    `/api/diagrams/${diagramId}/invitations`,
    { body: {}, email: ownerEmail, method: "POST" },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    invitation: InvitationResponse;
    token: string;
  };
}

/** Redeem an invitation token as one authenticated identity. */
async function redeemToken(token: string, email: string): Promise<Response> {
  return authenticatedRequest("/api/invitations/redeem", {
    body: { token },
    email,
    method: "POST",
  });
}

describe("Phase 3 invitations and membership", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("lets an owner invite a second identity who gains durable editor access", async () => {
    const diagram = await createDiagram(
      "Shared diagram",
      "owner-a@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-a@example.com");

    const redeemResponse = await redeemToken(token, "editor-a@example.com");
    expect(redeemResponse.status).toBe(200);
    const redeemBody = (await redeemResponse.json()) as { diagramId: string };
    expect(redeemBody.diagramId).toBe(diagram.id);

    const member = await env.DB.prepare(
      "SELECT role FROM diagram_members WHERE diagram_id = ? AND email = ?",
    )
      .bind(diagram.id, "editor-a@example.com")
      .first<{ role: string }>();
    expect(member).toMatchObject({ role: "editor" });

    // The new editor can now list, open, and edit the diagram.
    const listResponse = await authenticatedRequest("/api/diagrams", {
      email: "editor-a@example.com",
    });
    const listBody = (await listResponse.json()) as {
      diagrams: DiagramResponse[];
    };
    expect(listBody.diagrams.map((d) => d.id)).toContain(diagram.id);

    const openResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}`,
      { email: "editor-a@example.com" },
    );
    expect(openResponse.status).toBe(200);

    const operationResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        // Every new diagram is seeded with a `replace_document` operation at creation, so it is
        // already at revision 1 — see `../../src/worker/routes/diagrams.ts`'s `POST /` handler.
        body: {
          operationId: crypto.randomUUID(),
          baseRevision: 1,
          kind: "add_node",
          payload: {
            node: {
              id: "actor-1",
              type: "actor",
              position: { x: 0, y: 0 },
              data: { kind: "external-actor", label: "New actor" },
            },
          },
        },
        email: "editor-a@example.com",
        method: "POST",
      },
    );
    expect(operationResponse.status).toBe(200);
    const { result } = (await operationResponse.json()) as {
      result: { status: string };
    };
    expect(result.status).toBe("accepted");
  });

  it("rejects redeeming the same token a second time", async () => {
    const diagram = await createDiagram(
      "Single-use diagram",
      "owner-b@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-b@example.com");

    const first = await redeemToken(token, "editor-b@example.com");
    expect(first.status).toBe(200);

    const second = await redeemToken(token, "editor-c@example.com");
    expect(second.status).toBe(410);

    // The second (rejected) redeemer never gains membership.
    const member = await env.DB.prepare(
      "SELECT role FROM diagram_members WHERE diagram_id = ? AND email = ?",
    )
      .bind(diagram.id, "editor-c@example.com")
      .first();
    expect(member).toBeNull();
  });

  it("rejects a revoked invitation", async () => {
    const diagram = await createDiagram(
      "Revoked diagram",
      "owner-c@example.com",
    );
    const { invitation, token } = await createInvitation(
      diagram.id,
      "owner-c@example.com",
    );

    const revokeResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations/${invitation.id}`,
      { body: {}, email: "owner-c@example.com", method: "DELETE" },
    );
    expect(revokeResponse.status).toBe(204);

    const redeemResponse = await redeemToken(token, "editor-d@example.com");
    expect(redeemResponse.status).toBe(410);
  });

  it("revokes idempotently, including for an already-revoked or unknown invitation id", async () => {
    const diagram = await createDiagram(
      "Idempotent revoke",
      "owner-d@example.com",
    );
    const { invitation } = await createInvitation(
      diagram.id,
      "owner-d@example.com",
    );

    const first = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations/${invitation.id}`,
      { body: {}, email: "owner-d@example.com", method: "DELETE" },
    );
    expect(first.status).toBe(204);

    const second = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations/${invitation.id}`,
      { body: {}, email: "owner-d@example.com", method: "DELETE" },
    );
    expect(second.status).toBe(204);

    const unknown = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations/does-not-exist`,
      { body: {}, email: "owner-d@example.com", method: "DELETE" },
    );
    expect(unknown.status).toBe(204);
  });

  it("rejects an expired invitation", async () => {
    const diagram = await createDiagram(
      "Expiring diagram",
      "owner-e@example.com",
    );
    const { invitation, token } = await createInvitation(
      diagram.id,
      "owner-e@example.com",
    );

    await env.DB.prepare(
      "UPDATE diagram_invites SET expires_at = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() - 1000).toISOString(), invitation.id)
      .run();

    const redeemResponse = await redeemToken(token, "editor-e@example.com");
    expect(redeemResponse.status).toBe(410);
  });

  it("rejects a malformed token", async () => {
    const response = await redeemToken(
      "not-a-real-token",
      "someone@example.com",
    );
    expect(response.status).toBe(422);
  });

  it("rejects an unknown but well-formed token", async () => {
    const unknownToken = "A".repeat(43);
    const response = await redeemToken(unknownToken, "someone@example.com");
    expect(response.status).toBe(404);
  });

  it("keeps a token strictly scoped to the diagram it was created for", async () => {
    const diagramA = await createDiagram("Diagram A", "owner-f@example.com");
    const diagramB = await createDiagram("Diagram B", "owner-g@example.com");
    const { token } = await createInvitation(
      diagramA.id,
      "owner-f@example.com",
    );

    const response = await redeemToken(token, "editor-f@example.com");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { diagramId: string };
    expect(body.diagramId).toBe(diagramA.id);
    expect(body.diagramId).not.toBe(diagramB.id);

    const memberOfB = await env.DB.prepare(
      "SELECT role FROM diagram_members WHERE diagram_id = ? AND email = ?",
    )
      .bind(diagramB.id, "editor-f@example.com")
      .first();
    expect(memberOfB).toBeNull();
  });

  it("returns 404, not 403, when a non-member probes invitation management", async () => {
    const diagram = await createDiagram(
      "Non-member probe",
      "owner-h@example.com",
    );

    const createResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { body: {}, email: "stranger@example.com", method: "POST" },
    );
    expect(createResponse.status).toBe(404);

    const listResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { email: "stranger@example.com" },
    );
    expect(listResponse.status).toBe(404);

    const deleteResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations/anything`,
      { body: {}, email: "stranger@example.com", method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("returns 403, not 404, when a confirmed editor attempts an owner-only action", async () => {
    const diagram = await createDiagram(
      "Editor rejection",
      "owner-i@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-i@example.com");
    await redeemToken(token, "editor-i@example.com");

    const createResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { body: {}, email: "editor-i@example.com", method: "POST" },
    );
    expect(createResponse.status).toBe(403);

    const listResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { email: "editor-i@example.com" },
    );
    expect(listResponse.status).toBe(403);
  });

  it("lets both the owner and an editor see the member list, but not a non-member", async () => {
    const diagram = await createDiagram(
      "Member list diagram",
      "owner-j@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-j@example.com");
    await redeemToken(token, "editor-j@example.com");

    const ownerView = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/members`,
      { email: "owner-j@example.com" },
    );
    expect(ownerView.status).toBe(200);
    const ownerBody = (await ownerView.json()) as {
      members: { email: string; role: string }[];
    };
    expect(ownerBody.members).toHaveLength(2);
    expect(ownerBody.members).toEqual(
      expect.arrayContaining([
        { email: "owner-j@example.com", role: "owner" },
        { email: "editor-j@example.com", role: "editor" },
      ]),
    );

    const editorView = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/members`,
      { email: "editor-j@example.com" },
    );
    expect(editorView.status).toBe(200);

    const strangerView = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/members`,
      { email: "stranger-j@example.com" },
    );
    expect(strangerView.status).toBe(404);
  });

  it("does not let a non-member discover, read, or edit a diagram via any invitation-adjacent route", async () => {
    const diagram = await createDiagram(
      "Locked diagram",
      "owner-k@example.com",
    );

    const openResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}`,
      { email: "outsider@example.com" },
    );
    expect(openResponse.status).toBe(404);

    const operationResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          operationId: crypto.randomUUID(),
          baseRevision: 1,
          kind: "delete_node",
          payload: { nodeId: "does-not-matter" },
        },
        email: "outsider@example.com",
        method: "POST",
      },
    );
    expect(operationResponse.status).toBe(404);

    const membersResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/members`,
      { email: "outsider@example.com" },
    );
    expect(membersResponse.status).toBe(404);
  });

  it("rejects an invitation-management mutation from a foreign Origin", async () => {
    const diagram = await createDiagram("Origin test", "owner-l@example.com");
    const response = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      {
        body: {},
        email: "owner-l@example.com",
        method: "POST",
        origin: "http://attacker.test",
      },
    );
    expect(response.status).toBe(403);
  });

  it("rejects a redemption mutation from a foreign Origin", async () => {
    const diagram = await createDiagram(
      "Redeem origin test",
      "owner-m@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-m@example.com");
    const response = await authenticatedRequest("/api/invitations/redeem", {
      body: { token },
      email: "editor-m@example.com",
      method: "POST",
      origin: "http://attacker.test",
    });
    expect(response.status).toBe(403);
  });

  it("lets any member — owner or editor — rename a diagram", async () => {
    const diagram = await createDiagram(
      "Renamable diagram",
      "owner-n@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-n@example.com");
    await redeemToken(token, "editor-n@example.com");

    const response = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      body: { title: "Renamed by editor" },
      email: "editor-n@example.com",
      method: "PATCH",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { diagram: DiagramResponse };
    expect(body.diagram.title).toBe("Renamed by editor");
  });

  it("never returns the raw token or its digest in the active invitations list", async () => {
    const diagram = await createDiagram(
      "No leaking digest",
      "owner-o@example.com",
    );
    const { token } = await createInvitation(diagram.id, "owner-o@example.com");

    const listResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { email: "owner-o@example.com" },
    );
    const listBody = await listResponse.text();
    expect(listBody).not.toContain(token);
    expect(listBody).not.toContain("tokenDigest");
    expect(listBody).not.toContain("token_digest");
  });
});
