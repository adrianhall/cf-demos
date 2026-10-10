import { defineStore } from "pinia";
import { shallowRef } from "vue";

/** How a skill's content was provided (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 11, US-10) --
 * mirrors `src/worker/skills/types.ts`'s `SkillSourceType` (duplicated here, not imported,
 * matching `./chats.ts`'s existing convention of defining its own client-side shape rather than
 * importing the Worker's). */
export type SkillSourceType = "upload" | "url";

/** One personal skill, from `GET /api/skills`/`POST /api/skills` (docs/06-AGENTIC-CHAT.md
 * Section 6.4's `skills` table, scoped to the signed-in identity's own `owner_email`). */
export interface Skill {
  /** Server-generated identifier. */
  id: string;
  /** The skill's display name -- the literal string a model must pass to `activate_skill`. */
  name: string;
  /** How this skill's content was provided. */
  sourceType: SkillSourceType;
  /** The source URL this skill's content was fetched from, or `null` for an uploaded skill. */
  sourceRef: string | null;
  /** ISO 8601 timestamp this skill was added. */
  createdAt: string;
}

/** The `source` field `POST /api/skills`/`POST /api/admin/skills` both accept (Phase 11, US-10's
 * "each accepting an upload or a URL source" requirement). */
export type SkillSource =
  | { type: "upload"; content: string }
  | { type: "url"; url: string };

/** Request body for adding a skill, shared by {@link useSkillsStore.create} and
 * `./admin.ts`'s own enterprise-skill creation. */
export interface CreateSkillInput {
  /** The skill's display name -- also the literal string a model must pass to `activate_skill`
   * to use it. */
  name: string;
  /** The skill's one-line description, shown in every turn's system prompt catalog. */
  description: string;
  /** The skill's instruction body, as an upload or a URL to fetch it from. */
  source: SkillSource;
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
 * The signed-in identity's own personal skills (docs/06-AGENTIC-CHAT.md Phase 11, US-10) --
 * `SkillsView.vue`'s data source. Every mutation reloads the list from the Worker afterward
 * rather than optimistically guessing the server's resulting order, mirroring `./chats.ts`'s own
 * convention. See `./admin.ts`'s own enterprise-skill state for the admin-only equivalent.
 */
export const useSkillsStore = defineStore("skills", () => {
  const skills = shallowRef<Skill[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);

  /** Fetch the signed-in identity's own personal skill list. */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { skills: Skill[] };
      skills.value = body.skills;
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not load your skills.";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Add a personal skill and reload the list.
   *
   * @param input The new skill's name, description, and source.
   */
  async function create(input: CreateSkillInput): Promise<void> {
    error.value = null;
    try {
      const response = await fetch("/api/skills", {
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
        cause instanceof Error ? cause.message : "Could not add this skill.";
    }
  }

  /**
   * Delete a personal skill and reload the list.
   *
   * @param id Skill id to delete.
   */
  async function remove(id: string): Promise<void> {
    error.value = null;
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(await responseMessage(response));
      }
      await load();
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not delete this skill.";
    }
  }

  return { create, error, load, loading, remove, skills };
});
