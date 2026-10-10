import { r2, SkillRegistry } from "agents/skills";

/**
 * Build the per-request skill catalog `ChatAgent.onChatMessage()` slots into `streamText()`'s
 * `system`/`tools` (docs/06-AGENTIC-CHAT.md Phase 11, US-10). Per Spike D's decision
 * (`spikes/03-agent-skills-composability/REPORT.md`), this wires the *released* Agents SDK
 * mechanism -- `agents/skills`'s `SkillRegistry` over one or more R2-backed `SkillSource`s --
 * rather than a hand-rolled catalog, since it composes with `AIChatAgent` directly with zero
 * adapter code.
 *
 * Two sources compose one registry: a shared enterprise source every chat includes, and (only
 * when `ownerEmail` is known) a source scoped to that one owner's own personal skills
 * (`../skills/storage.ts`'s `skillDirectoryKey()`'s own per-owner prefix). This *is* the
 * mechanism enforcing US-10's "a personal skill is invisible to other users" acceptance
 * criterion -- each source only ever lists objects under its own prefix, so a personal source
 * literally cannot see another owner's directory, not merely an application-level filter over
 * one shared listing. When the same `name` exists in both an enterprise and a personal skill,
 * `SkillRegistry` itself keeps whichever source listed it first (enterprise, since it is listed
 * first below) and logs a warning -- `../skills/service.ts`'s own `findByNameInScope()` already
 * prevents this within one scope, but not across scopes, so this ordering is a deliberate,
 * documented tie-break, not an oversight.
 *
 * `ownerEmail` may be `undefined` for a `ChatAgent` instance woken with no `props` at all
 * (mirrors `chat-agent.ts`'s own `route`/`business` fallbacks) -- in that case only the
 * enterprise source is included, never a personal source scoped to `"undefined"`.
 *
 * @param bucket R2 bucket binding (`FILES`) skills are stored under (Section 6.1's shared-bucket
 * decision).
 * @param ownerEmail The calling chat's verified owner identity, or `undefined`.
 * @returns A `SkillRegistry` ready for `.systemPrompt()`/`.tools()` (call `.systemPrompt()` to
 * completion *before* `.tools()` -- never concurrently; see `chat-agent.ts`'s own JSDoc for the
 * real bug Spike D hit and fixed).
 */
export function buildSkillRegistry(
  bucket: R2Bucket,
  ownerEmail: string | undefined,
): SkillRegistry {
  const sources = [r2(bucket, { prefix: "skills/enterprise/" })];
  if (ownerEmail !== undefined) {
    sources.push(r2(bucket, { prefix: `skills/personal/${ownerEmail}/` }));
  }
  return new SkillRegistry(sources);
}
