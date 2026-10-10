import { defineStore } from "pinia";
import { shallowRef } from "vue";
import type { ChatUsageSummary } from "../composables/useChatAgent";
import type { CreateSkillInput, Skill } from "./skills";

/**
 * This demo's admin-settable business segment (docs/06-AGENTIC-CHAT.md Section 6.4/6.5, Phase 7,
 * US-6) -- mirrors `src/worker/users/business.ts`'s `Business` (duplicated here, not imported,
 * matching `./chats.ts`'s existing `ChatRoute` convention of defining its own client-side shape
 * rather than importing the Worker's).
 */
export type Business = "field" | "product" | "leadership";

/** Every valid {@link Business}, in the order the admin editor's dropdown should offer them. */
export const BUSINESS_VALUES: readonly Business[] = [
  "field",
  "product",
  "leadership",
];

/** This demo's admin-settable geo segment. See {@link Business}'s own rationale. */
export type Geo = "emea" | "apac" | "americas";

/** Every valid {@link Geo}, in the order the admin editor's dropdown should offer them. */
export const GEO_VALUES: readonly Geo[] = ["emea", "apac", "americas"];

/** One row of the admin console's ranked user-cost table (`GET /api/admin/users`). */
export interface AdminUser {
  /** Verified Cloudflare Access identity email. */
  email: string;
  /** Whether this identity holds this demo's D1-flagged administrator role. */
  isAdmin: boolean;
  /** This identity's admin-assigned business segment, or `null` if unset. */
  business: Business | null;
  /** This identity's admin-assigned geo segment, or `null` if unset. */
  geo: Geo | null;
  /** ISO 8601 timestamp of this identity's first sign-in. */
  createdAt: string;
  /** This identity's running cost/token totals, summed across every chat they own. */
  usage: ChatUsageSummary;
}

/** One row of the cost-by-business report (`GET /api/admin/reports/by-business`). */
export interface BusinessReportRow {
  /** The business segment this row summarizes, or `null` for "unspecified." */
  business: Business | null;
  /** Summed totals for every chat owned by a user in this segment. */
  usage: ChatUsageSummary;
}

/** One row of the cost-by-geo report (`GET /api/admin/reports/by-geo`). */
export interface GeoReportRow {
  /** The geo segment this row summarizes, or `null` for "unspecified." */
  geo: Geo | null;
  /** Summed totals for every chat owned by a user in this segment. */
  usage: ChatUsageSummary;
}

/** RFC 9457 error response shape used for safe client error messages. */
interface ProblemDetails {
  /** Human-readable explanation of the failed request. */
  detail?: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Request failed with status ${response.status}.`;
}

/**
 * The admin console's own data (docs/06-AGENTIC-CHAT.md Phase 7, US-6): every signed-in user's
 * cost ranking, and the two cost-by-segment reports. This store's own fetches are the **real**
 * enforcement boundary's client-visible surface -- `requireAdmin()` (`../../worker/middleware/
 * require-admin.ts`) rejects a non-administrator identity with `403` before any of these routes
 * ever runs, so a non-admin who somehow reaches `AdminView.vue` (its nav entry point is only
 * ever hidden, never a route guard -- Section 6.5's "never trust the client-hidden nav item
 * alone") sees this store's own `error`, not real data.
 */
export const useAdminStore = defineStore("admin", () => {
  const users = shallowRef<AdminUser[]>([]);
  const byBusiness = shallowRef<BusinessReportRow[]>([]);
  const byGeo = shallowRef<GeoReportRow[]>([]);
  /** Every enterprise skill (docs/06-AGENTIC-CHAT.md Phase 11, US-10) -- visible to every chat's
   * own skill catalog, managed only from here. */
  const enterpriseSkills = shallowRef<Skill[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);

  /** Fetch the ranked user-cost table, both segment reports, and the enterprise skill catalog,
   * all in parallel. */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [usersResponse, businessResponse, geoResponse, skillsResponse] =
        await Promise.all([
          fetch("/api/admin/users"),
          fetch("/api/admin/reports/by-business"),
          fetch("/api/admin/reports/by-geo"),
          fetch("/api/admin/skills"),
        ]);
      if (!usersResponse.ok) {
        throw new Error(await responseMessage(usersResponse));
      }
      if (!businessResponse.ok) {
        throw new Error(await responseMessage(businessResponse));
      }
      if (!geoResponse.ok) {
        throw new Error(await responseMessage(geoResponse));
      }
      if (!skillsResponse.ok) {
        throw new Error(await responseMessage(skillsResponse));
      }
      users.value = (
        (await usersResponse.json()) as { users: AdminUser[] }
      ).users;
      byBusiness.value = (
        (await businessResponse.json()) as { report: BusinessReportRow[] }
      ).report;
      byGeo.value = (
        (await geoResponse.json()) as { report: GeoReportRow[] }
      ).report;
      enterpriseSkills.value = (
        (await skillsResponse.json()) as { skills: Skill[] }
      ).skills;
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not load the admin console.";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Add an enterprise skill and reload every view afterward.
   *
   * @param input The new skill's name, description, and source.
   */
  async function createSkill(input: CreateSkillInput): Promise<void> {
    error.value = null;
    try {
      const response = await fetch("/api/admin/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      await load();
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not add this enterprise skill.";
    }
  }

  /**
   * Delete an enterprise skill and reload every view afterward.
   *
   * @param id Skill id to delete.
   */
  async function removeSkill(id: string): Promise<void> {
    error.value = null;
    try {
      const response = await fetch(
        `/api/admin/skills/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(await responseMessage(response));
      }
      await load();
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not delete this enterprise skill.";
    }
  }

  /**
   * Set a user's business/geo segments and reload every view afterward, so a metadata change is
   * immediately reflected in both the ranked table and the two segment reports.
   *
   * @param email The user to update.
   * @param business The new business segment, or `null` to clear it.
   * @param geo The new geo segment, or `null` to clear it.
   */
  async function updateMetadata(
    email: string,
    business: Business | null,
    geo: Geo | null,
  ): Promise<void> {
    error.value = null;
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(email)}`,
        {
          body: JSON.stringify({ business, geo }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      await load();
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not update this user's metadata.";
    }
  }

  return {
    byBusiness,
    byGeo,
    createSkill,
    enterpriseSkills,
    error,
    load,
    loading,
    removeSkill,
    updateMetadata,
    users,
  };
});
