import type { ChatRoute } from "./route";

/**
 * A chat directory entry: the D1 row backing one `ChatAgent` Durable Object instance
 * (docs/06-AGENTIC-CHAT.md Section 6.2/6.4). The Durable Object itself, not this row, is the
 * source of truth for conversation content -- this row exists so the Worker can enforce
 * ownership before ever routing a request to that instance, and (from Phase 3 onward) list a
 * user's chats without waking every one of their Durable Objects.
 */
export interface Chat {
  /** Server-generated identifier, also the `ChatAgent` Durable Object's instance name. */
  id: string;
  /** Verified Cloudflare Access identity that created and exclusively owns this chat. */
  ownerEmail: string;
  /** Short generated title, or `null` until Phase 3's auto-titling runs after the first turn. */
  title: string | null;
  /** Selected AI Gateway dynamic route (docs/06-AGENTIC-CHAT.md Phase 4, US-3) -- never `null`
   * for a chat this repository created: `ChatRepository.create()` always writes the default
   * route (`"basic"`, see `./route.ts`'s `DEFAULT_CHAT_ROUTE`), and `ChatRepository`'s own row
   * mapping defensively coerces an unexpected stored value back to that default rather than
   * ever surfacing `null` here. */
  route: ChatRoute;
  /** ISO 8601 timestamp of chat creation. */
  createdAt: string;
  /** ISO 8601 timestamp of the chat's most recent activity; only ever set at creation until a
   * later phase updates it per turn (Phase 3's recency-ordered sidebar). */
  updatedAt: string;
}
