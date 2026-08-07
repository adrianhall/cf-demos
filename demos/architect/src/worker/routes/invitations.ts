import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import { InvitationRepository } from "../invitations/repository";
import { validateRedeemInvitationInput } from "../invitations/validation";
import { readJsonBody } from "../lib/read-json-body";
import { requestBodyLimit } from "../middleware/body-limit";
import { requireSameOriginMutation } from "../middleware/mutation-guard";

/**
 * Authenticated invitation redemption, mounted at `/api/invitations` by `../index.ts`.
 *
 * Deliberately not nested under `/api/diagrams/:id`: a raw invitation token already fully
 * identifies its diagram (`InvitationRepository.redeem()` looks it up by digest), so redemption
 * needs no diagram id in its own path — there is no cross-diagram ambiguity to resolve. Keeping
 * the raw token in a same-origin JSON body, never a URL path or query string, matches the Access
 * Model's requirement that a bearer capability never leak into a server/proxy access log or a
 * `Referer` header.
 */
export const invitationsRouter = new Hono<AppBindings>();

invitationsRouter.use(requireSameOriginMutation);
invitationsRouter.use(requestBodyLimit);

/**
 * Redeem an invitation token (`{ "token": "..." }`), granting the caller durable `editor`
 * membership on the invitation's diagram.
 */
invitationsRouter.post("/redeem", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity").email;
  const input = validateRedeemInvitationInput(
    await readJsonBody(context.req.raw),
  );

  const invitations = new InvitationRepository(context.env.DB);
  const { diagramId } = await invitations.redeem(input.token, identity);

  const diagrams = new DiagramRepository(context.env.DB);
  await diagrams.addMember(diagramId, identity, "editor");

  context.get("LOGGER").info("invitation_redeemed", { diagramId });
  return context.json({ diagramId });
});
