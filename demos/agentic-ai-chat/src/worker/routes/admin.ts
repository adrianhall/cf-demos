import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { UsageRepository } from "../usage/repository";
import { emptyUsageSummary } from "../usage/types";
import {
  BUSINESS_VALUES,
  GEO_VALUES,
  isBusiness,
  isGeo,
} from "../users/business";
import { UserRepository } from "../users/repository";

/**
 * Admin cost/metadata console API mounted at `/api/admin` (docs/06-AGENTIC-CHAT.md Phase 7,
 * US-6). `requireAdmin` (`../middleware/require-admin.ts`) is mounted in front of every route
 * here (`../index.ts`), so every handler below can assume the verified identity already holds
 * this demo's D1-flagged administrator role.
 */
export const adminRouter = new Hono<AppBindings>();

/**
 * List every signed-in user, ranked by total cost descending -- the admin console's own primary
 * view (US-6's "an admin sees a ranked list of users by total cost" acceptance criterion). Each
 * user's `usage` carries the same `ChatUsageSummary` shape (and so the same "AI Gateway"/
 * "Estimated" confirmation-ratio treatment, Section 6.6a) Phase 6 already established for a
 * single chat, summed here across every chat that user owns (Section 6.6's "always the best
 * available number" -- summed regardless of `cost_source`).
 */
adminRouter.get("/users", async (context) => {
  const [users, usageByEmail] = await Promise.all([
    new UserRepository(context.env.DB).list(),
    new UsageRepository(context.env.DB).aggregateForAllUsers(),
  ]);
  const withUsage = users.map((user) => ({
    ...user,
    usage: usageByEmail.get(user.email) ?? emptyUsageSummary(),
  }));
  withUsage.sort((a, b) => b.usage.totalCostUsd - a.usage.totalCostUsd);
  return context.json({ users: withUsage });
});

/**
 * Set a user's business/geo segments (US-6's "can edit any user's business/geo" acceptance
 * criterion). Both fields are always required in the request body, each either a valid enum
 * literal or explicit `null` -- there is no partial-update shorthand, so this route never has to
 * guess whether an omitted field means "leave unchanged" or "clear it" (see
 * `UserRepository.updateMetadata()`'s own JSDoc).
 */
adminRouter.patch("/users/:email", async (context) => {
  const email = context.req.param("email");
  const body = await context.req.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    throw badRequest({
      detail: "Request body must be a JSON object with business and geo.",
    });
  }
  const { business, geo } = body as { business?: unknown; geo?: unknown };
  if (business !== null && !isBusiness(business)) {
    throw badRequest({
      detail: `business must be one of: ${BUSINESS_VALUES.join(", ")}, or null.`,
    });
  }
  if (geo !== null && !isGeo(geo)) {
    throw badRequest({
      detail: `geo must be one of: ${GEO_VALUES.join(", ")}, or null.`,
    });
  }
  const repository = new UserRepository(context.env.DB);
  const updated = await repository.updateMetadata(email, business, geo);
  if (updated === null) {
    throw notFound({ detail: `No user found for ${email}.` });
  }
  context.get("LOGGER").info("admin_user_metadata_updated", {
    business,
    email,
    geo,
  });
  return context.json({ user: updated });
});

/**
 * Cost aggregated by business segment (US-6's "sees cost totals broken down by business"
 * acceptance criterion), ranked by total cost descending like `GET /users`.
 */
adminRouter.get("/reports/by-business", async (context) => {
  const usageByBusiness = await new UsageRepository(
    context.env.DB,
  ).aggregateByBusiness();
  const report = [...usageByBusiness.entries()].map(([business, usage]) => ({
    business,
    usage,
  }));
  report.sort((a, b) => b.usage.totalCostUsd - a.usage.totalCostUsd);
  return context.json({ report });
});

/**
 * Cost aggregated by geo segment (US-6's "and by geo" acceptance criterion), ranked by total
 * cost descending like `GET /users`.
 */
adminRouter.get("/reports/by-geo", async (context) => {
  const usageByGeo = await new UsageRepository(context.env.DB).aggregateByGeo();
  const report = [...usageByGeo.entries()].map(([geo, usage]) => ({
    geo,
    usage,
  }));
  report.sort((a, b) => b.usage.totalCostUsd - a.usage.totalCostUsd);
  return context.json({ report });
});
