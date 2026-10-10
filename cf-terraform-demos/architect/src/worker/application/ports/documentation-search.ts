/**
 * One documentation page the search matched.
 *
 * Normalised deliberately down to three fields. Whatever an upstream documentation service returns,
 * this is all a chat turn can use: enough for the model to ground an answer, and enough for the UI
 * to render a citation the reader can follow.
 */
export interface DocumentationResult {
  /**
   * Title of the documentation page.
   */
  title: string;
  /**
   * Absolute URL of the page, used as the citation link.
   */
  url: string;
  /**
   * Short excerpt of the matched content, already truncated by the adapter.
   *
   * Truncation is the adapter's job rather than the caller's, because the reason for it is a
   * property of the transport: an upstream page body can run to several thousand characters, and
   * relaying one verbatim into a prompt that is re-sent on every round of a turn is a cost with no
   * corresponding benefit.
   */
  snippet: string;
}

/**
 * What a documentation search produced.
 *
 * A value rather than a thrown error, for the same reason `./diagram-session.ts`'s
 * `RejectedGraphWrite` is: the caller is a chat turn in progress, and an upstream service being
 * slow or unreachable is an ordinary event that the turn should survive. An exception would end a
 * conversation the user is watching over a lookup the assistant could simply have done without.
 */
export type DocumentationSearchOutcome =
  | {
      /**
       * Discriminator: the search completed.
       */
      ok: true;
      /**
       * Matching pages, best match first. Empty when the service genuinely matched nothing — which
       * is a successful search, not a failure.
       */
      results: DocumentationResult[];
    }
  | {
      /**
       * Discriminator: the search did not complete.
       */
      ok: false;
      /**
       * User-and-model-safe explanation, suitable to pass straight back as a tool result. It never
       * carries the underlying cause: an upstream stack trace or hostname in a message the model
       * may quote is an information leak with no diagnostic value to the reader.
       */
      message: string;
    };

/**
 * Port for searching Cloudflare's published product documentation.
 *
 * This is the seam that keeps the chat's documentation tool independent of how the lookup is
 * actually performed. The application tier asks "what does the documentation say about X?"; only
 * `../../infrastructure/ai/docs-client.ts` knows that answering means opening an MCP connection to
 * a public server, calling one tool, and parsing a text format out of the result.
 *
 * It is a port for two concrete reasons rather than on principle. The first is testability: a chat
 * turn can be exercised against an in-memory implementation with no network and no mocking of a
 * third-party SDK. The second is that this is the one outbound call in the whole feature, so it is
 * the one place a future change — a different source, a cache, a per-account quota — would land,
 * and a port means that change has somewhere to land that is not the chat engine.
 *
 * Note what this interface does **not** have: a throwing variant. The adapter exports one, for its
 * own tests, but nothing above infrastructure should be able to reach it, because a caller who can
 * throw on a docs lookup will eventually do so.
 */
export interface DocumentationSearchPort {
  /**
   * Searches the documentation and reports what was found.
   *
   * @param query Free-text query, as the model phrased it.
   * @returns The matching pages, or a non-fatal failure outcome carrying a message safe to relay to
   *   both the model and the user. An empty result set is reported as a success.
   * @throws Nothing. Every failure — timeout, transport error, an error reported by the service
   *   itself — is reported as `{ ok: false }`, so one unavailable lookup can never abort a chat
   *   turn that was otherwise going fine.
   */
  search(query: string): Promise<DocumentationSearchOutcome>;
}
