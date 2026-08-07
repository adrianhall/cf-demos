import {
  badRequest,
  internalServerError,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { problemDetails } from "@adrianhall/cloudflare-toolkit/problem-details";
import { Hono } from "hono";
import {
  TRUSTED_IDENTITY_HEADER,
  TRUSTED_ROLE_HEADER,
} from "../../collaboration-protocol";
import { getBlueprint } from "../../graph/blueprints";
import type { GraphDocument } from "../../graph/types";
import { validateGraphDocument } from "../../graph/validation";
import { ArchitectureJobRepository } from "../architecture/repository";
import { deriveIdempotentJobId } from "../architecture/idempotency";
import {
  MAX_DIAGRAM_NODES_FOR_PROPOSAL,
  PROPOSAL_RATE_LIMIT_MS,
  validateStartProposalInput,
} from "../architecture/validation";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import { validateOperationInput } from "../diagrams/operation-input";
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput,
} from "../diagrams/validation";
import { InvitationRepository } from "../invitations/repository";
import { readJsonBody } from "../lib/read-json-body";
import { requestBodyLimit } from "../middleware/body-limit";
import {
  requireSameOriginMutation,
  requireSameOriginUpgrade,
} from "../middleware/mutation-guard";

/**
 * Diagram library, document, membership, and invitation-management API, mounted at
 * `/api/diagrams` by `../index.ts`.
 *
 * Every route runs after `accessMiddleware` (see `../middleware/access.ts`), so
 * `Cloudflare_Access_Identity` is always set. Phase 3 widens list/open/rename/operations
 * authorization from Phase 2's owner-only `owner_email` check to `diagram_members` membership
 * (owner or editor) via `DiagramRepository.getAccessible()`; invitation management stays
 * owner-only via `DiagramRepository.requireOwner()`. Invitation *redemption* is a separate,
 * non-diagram-scoped route — see `./invitations.ts` — because a raw token already fully
 * identifies its diagram. Phase 4 adds the `GET /:id/ws` live-collaboration upgrade route below;
 * it authorizes membership the same way as every other route here but forwards the caller's
 * verified identity and role to `DiagramRoom` as trusted headers instead of returning JSON.
 */
export const diagramsRouter = new Hono<AppBindings>();

diagramsRouter.use(requireSameOriginMutation);
diagramsRouter.use(requestBodyLimit);

/** List every diagram the caller can access (owner or editor membership), most recently updated first. */
diagramsRouter.get("/", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  return context.json({
    diagrams: await repository.listAccessibleBy(identity),
  });
});

/**
 * Create a diagram, its owner membership row, and seed its `DiagramRoom` document from a
 * starter blueprint (`{ "title": "...", "blueprintId"?: "blank" | "static-site" | "api-storage" }`).
 */
diagramsRouter.post("/", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity").email;
  const input = validateCreateDiagramInput(await readJsonBody(context.req.raw));
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.create(identity, input.title);

  const blueprint = getBlueprint(input.blueprintId);
  const room = context.env.DIAGRAM_ROOM.getByName(diagram.id);
  await room.applyOperation({
    operationId: crypto.randomUUID(),
    baseRevision: 0,
    kind: "replace_document",
    payload: { document: blueprint.document },
  });

  context.get("LOGGER").info("diagram_created", { diagramId: diagram.id });
  return context.json({ diagram }, 201);
});

/** Read one diagram's directory metadata plus its `DiagramRoom`'s current revision/document. */
diagramsRouter.get("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.getAccessible(identity, id);

  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const snapshot = await room.readDocument();

  context.get("LOGGER").info("diagram_opened", { diagramId: id });
  return context.json({
    diagram,
    revision: snapshot.revision,
    document: snapshot.document,
  });
});

/** Rename a diagram (`{ "title": "..." }`). Any member — owner or editor — may rename. */
diagramsRouter.patch("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const input = validateUpdateDiagramInput(await readJsonBody(context.req.raw));
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.rename(identity, id, input.title);

  context.get("LOGGER").info("diagram_updated", { diagramId: id });
  return context.json({ diagram });
});

/** List a diagram's members (email + role). Visible to any member, not owner-only. */
diagramsRouter.get("/:id/members", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getAccessible(identity, id);

  return context.json({ members: await repository.listMembers(id) });
});

/**
 * Create an editor invitation for a diagram. Owner-only.
 *
 * The raw token is returned exactly once, in this response — see
 * `../invitations/repository.ts`'s `create()`. No request body fields are read; creating an
 * invitation needs nothing beyond the diagram id and the caller's verified identity.
 */
diagramsRouter.post("/:id/invitations", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const diagrams = new DiagramRepository(context.env.DB);
  await diagrams.requireOwner(identity, id);

  const invitations = new InvitationRepository(context.env.DB);
  const created = await invitations.create(id, identity);

  context.get("LOGGER").info("diagram_invitation_created", { diagramId: id });
  return context.json(created, 201);
});

/** List a diagram's currently redeemable invitations. Owner-only. */
diagramsRouter.get("/:id/invitations", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const diagrams = new DiagramRepository(context.env.DB);
  await diagrams.requireOwner(identity, id);

  const invitations = new InvitationRepository(context.env.DB);
  return context.json({ invitations: await invitations.listActive(id) });
});

/**
 * Revoke one invitation (identified by its opaque `InvitationSummary.id`, never the raw token or
 * its digest). Owner-only, idempotent.
 */
diagramsRouter.delete("/:id/invitations/:invitationId", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const diagrams = new DiagramRepository(context.env.DB);
  await diagrams.requireOwner(identity, id);

  const invitations = new InvitationRepository(context.env.DB);
  await invitations.revoke(id, context.req.param("invitationId"));

  context.get("LOGGER").info("diagram_invitation_revoked", { diagramId: id });
  return context.body(null, 204);
});

/**
 * Forward one revisioned document edit to `DiagramRoom.applyOperation`
 * (`{ "operationId": "...", "baseRevision": 0, "kind": "...", "payload": {...} }`).
 *
 * Any member — owner or editor — may submit an operation, per Phase 3's "owner and editor can
 * edit" rule. Phase 2 was single-user, but edits still flow through this exact
 * revisioned-command endpoint so Phase 4's WebSocket transport can be added without replacing
 * the persistence model.
 */
diagramsRouter.post("/:id/operations", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getAccessible(identity, id);

  const operation = validateOperationInput(await readJsonBody(context.req.raw));
  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const result = await room.applyOperation(operation);

  if (result.status === "rejected") {
    throw unprocessableContent({ detail: result.error });
  }
  if (result.status === "accepted") {
    await repository.touchUpdatedAt(id);
  }

  context.get("LOGGER").info("diagram_updated", {
    diagramId: id,
    status: result.status,
  });
  return context.json({ result });
});

/**
 * Start an AI architecture proposal Workflow (`docs/09-ARCHITECT.md`'s Phase 5 AI Workflow —
 * `{ "prompt": "...", "idempotencyKey"?: "..." }`).
 *
 * Any member — owner or editor — may request a proposal. This route derives diagram identity,
 * membership, and the diagram's current revision entirely server-side (never trusting a client-
 * supplied revision) before enforcing, in order: a graph-size bound on the *current* diagram
 * (`MAX_DIAGRAM_NODES_FOR_PROPOSAL` — unrelated to the AI schema's own 2-8 proposed-node bound),
 * the idempotency-key duplicate check, one-active-job-per-diagram, and a per-requester start-rate
 * throttle — see `../architecture/validation.ts` and `../architecture/idempotency.ts` for exactly
 * how each is computed. The job id doubles as the `ArchitectureWorkflow` instance id.
 */
diagramsRouter.post("/:id/proposals", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getAccessible(identity, id);

  const input = validateStartProposalInput(await readJsonBody(context.req.raw));

  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const snapshot = await room.readDocument();
  if (snapshot.document.nodes.length > MAX_DIAGRAM_NODES_FOR_PROPOSAL) {
    throw unprocessableContent({
      detail: `This diagram has more than ${MAX_DIAGRAM_NODES_FOR_PROPOSAL} nodes, too many for an AI proposal.`,
    });
  }

  const jobs = new ArchitectureJobRepository(context.env.DB);
  const jobId = input.idempotencyKey
    ? await deriveIdempotentJobId(id, identity, input.idempotencyKey)
    : crypto.randomUUID();

  const existing = await jobs.findById(jobId);
  if (existing) {
    context.get("LOGGER").info("architecture_job_started", {
      diagramId: id,
      jobId,
      duplicate: true,
    });
    return context.json({ job: existing, duplicate: true });
  }

  const active = await jobs.findActiveForDiagram(id);
  if (active) {
    throw problemDetails({
      status: 409,
      title: "Conflict",
      detail: "A proposal is already in progress for this diagram.",
    });
  }

  const recent = await jobs.mostRecentByRequester(identity);
  if (
    recent &&
    Date.now() - Date.parse(recent.createdAt) < PROPOSAL_RATE_LIMIT_MS
  ) {
    throw problemDetails({
      status: 429,
      title: "Too Many Requests",
      detail: "Please wait before starting another proposal.",
    });
  }

  await jobs.ensureJob({
    id: jobId,
    workflowInstanceId: jobId,
    diagramId: id,
    baseRevision: snapshot.revision,
    requesterEmail: identity,
  });
  try {
    await context.env.ARCHITECTURE_WORKFLOW.create({
      id: jobId,
      params: {
        diagramId: id,
        baseRevision: snapshot.revision,
        requesterEmail: identity,
        prompt: input.prompt,
      },
    });
  } catch {
    // A concurrent request with the same idempotency key may have already created the Workflow
    // instance between this route's own duplicate check and this call — `Workflow.create()`
    // throws if the id already exists. Treat that race the same as an ordinary duplicate.
    const created = await jobs.findById(jobId);
    if (created) {
      return context.json({ job: created, duplicate: true });
    }
    throw internalServerError({ detail: "Could not start the proposal." });
  }

  const created = await jobs.findById(jobId);
  if (!created) {
    throw internalServerError({ detail: "Could not start the proposal." });
  }

  context.get("LOGGER").info("architecture_job_started", {
    diagramId: id,
    jobId,
    duplicate: false,
  });
  return context.json({ job: created, duplicate: false }, 201);
});

/**
 * Read one architecture job's D1 status plus `DiagramRoom`'s last notification for it, and — once
 * `"ready"` — the validated proposed document itself, so the client can render a preview.
 *
 * Mirrors Spike 10's measured `GET /jobs/:id` contract (D1 plus Durable Object), authorized the
 * same way as every other diagram route (owner or editor membership).
 */
diagramsRouter.get("/:id/proposals/:jobId", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const jobId = context.req.param("jobId");
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getAccessible(identity, id);

  const jobs = new ArchitectureJobRepository(context.env.DB);
  const job = await jobs.findById(jobId);
  if (!job || job.diagramId !== id) {
    throw notFound({ detail: "Proposal job not found." });
  }

  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const notification = await room.getJobNotification(jobId);

  let proposal: GraphDocument | undefined;
  if (job.status === "ready" && job.proposalR2Key) {
    const object = await context.env.SNAPSHOTS.get(job.proposalR2Key);
    if (object) {
      proposal = validateGraphDocument(JSON.parse(await object.text()));
    }
  }

  return context.json({ job, notification, proposal });
});

/**
 * Accept a `"ready"` proposal as one atomic `replace_document` revision.
 *
 * Re-derives the diagram's *current* revision server-side and compares it against the job's own
 * `baseRevision` — captured when the Workflow started — **before** even attempting the apply, so
 * a stale proposal is rejected with a specific, user-actionable reason
 * (`extensions.reason === "stale_base_revision"`) rather than a generic error. `applyOperation`'s
 * own `"stale"` result is still the backstop for a genuinely concurrent edit that lands between
 * this check and the apply itself.
 */
diagramsRouter.post("/:id/proposals/:jobId/accept", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const jobId = context.req.param("jobId");
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getAccessible(identity, id);

  const jobs = new ArchitectureJobRepository(context.env.DB);
  const job = await jobs.findById(jobId);
  if (!job || job.diagramId !== id) {
    throw notFound({ detail: "Proposal job not found." });
  }
  if (job.status !== "ready" || !job.proposalR2Key) {
    throw unprocessableContent({
      detail: "This proposal is not ready to accept.",
    });
  }

  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const current = await room.readDocument();
  const staleDetail =
    "The diagram changed since this proposal was generated. Please regenerate the proposal.";
  if (current.revision !== job.baseRevision) {
    throw unprocessableContent({
      detail: staleDetail,
      extensions: { reason: "stale_base_revision" },
    });
  }

  const object = await context.env.SNAPSHOTS.get(job.proposalR2Key);
  if (!object) {
    throw internalServerError({ detail: "The proposal document is missing." });
  }
  const document = validateGraphDocument(JSON.parse(await object.text()));

  const result = await room.applyOperation({
    operationId: crypto.randomUUID(),
    baseRevision: job.baseRevision,
    kind: "replace_document",
    payload: { document },
  });

  if (result.status === "stale") {
    throw unprocessableContent({
      detail: staleDetail,
      extensions: { reason: "stale_base_revision" },
    });
  }
  if (result.status === "rejected") {
    throw unprocessableContent({ detail: result.error });
  }
  await repository.touchUpdatedAt(id);

  context.get("LOGGER").info("architecture_proposal_accepted", {
    diagramId: id,
    jobId,
  });
  return context.json({ result });
});

/**
 * Authenticated hibernatable-WebSocket upgrade route for live cooperative editing
 * (`docs/09-ARCHITECT.md`'s Phase 4 Collaboration Protocol).
 *
 * `accessMiddleware` (mounted globally in `../index.ts`) already required a valid Access
 * identity before this handler runs. This route additionally, in order:
 *
 * 1. Validates the diagram id (`404` for a malformed id, matching every other route).
 * 2. Enforces same-origin (`requireSameOriginUpgrade` — a WebSocket upgrade is a connecting
 *    action, not an ordinary safe `GET`, so `requireSameOriginMutation`'s method-based bypass
 *    above does not cover it; see that function's own documentation).
 * 3. Requires an actual `Upgrade: websocket` request.
 * 4. Checks D1 membership (owner **or** editor) via `DiagramRepository.getAccessibleWithRole()`
 *    — `404` for a non-member, identical to every other diagram route.
 * 5. Strips any client-supplied trusted headers and sets the Worker's own verified
 *    `X-Architect-Identity`/`X-Architect-Role` before forwarding to `DiagramRoom`. The Durable
 *    Object trusts only these Worker-added values — see `../diagram-room.ts` and
 *    `../diagram-room-protocol.ts`'s `parseTrustedIdentity()`.
 */
diagramsRouter.get("/:id/ws", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  requireSameOriginUpgrade(context.req.raw);
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest({ detail: "Expected a WebSocket upgrade request." });
  }

  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const { role } = await repository.getAccessibleWithRole(identity, id);

  const headers = new Headers(context.req.raw.headers);
  headers.delete(TRUSTED_IDENTITY_HEADER);
  headers.delete(TRUSTED_ROLE_HEADER);
  headers.set(TRUSTED_IDENTITY_HEADER, identity);
  headers.set(TRUSTED_ROLE_HEADER, role);

  context.get("LOGGER").info("diagram_room_connect", { diagramId: id, role });
  return context.env.DIAGRAM_ROOM.getByName(id).fetch(
    new Request(context.req.raw, { headers }),
  );
});
