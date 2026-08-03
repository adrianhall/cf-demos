/** A user directory entry shared by every route that needs identity or authorization state. */
export interface User {
  /** Stable, verified Cloudflare Access email used as the primary key everywhere else in this
   * demo (chat ownership, usage attribution, admin metadata). */
  email: string;
  /** Whether this identity holds this demo's application-level administrator role (a D1 flag,
   * not a Cloudflare Access concept -- see docs/06-AGENTIC-CHAT.md Section 6.5). */
  isAdmin: boolean;
  /** ISO 8601 timestamp of this user's first sign-in. */
  createdAt: string;
}
