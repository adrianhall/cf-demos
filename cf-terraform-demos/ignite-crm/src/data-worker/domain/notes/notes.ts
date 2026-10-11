/**
 * @file Notes domain rules: link-set normalisation, the author-or-manager edit rule, safe FTS5
 *   query construction, and snippet parsing. Pure functions with no storage or transport knowledge,
 *   so every rule is unit-tested directly and every transport enforces it identically.
 */

import {
  NOTE_LINK_TYPES,
  type NoteLinkRef,
  type NoteLinkType,
  type SnippetSegment
} from '../../../shared/api/notes.ts';

/**
 * Most search tokens used from one query. Extra words add little to a small team's note set and
 * would only make the FTS expression longer.
 */
export const MAX_SEARCH_TOKENS = 8;

/**
 * Private-use characters that bracket matched text in an FTS5 `snippet()`. They cannot be typed in
 * a search box, and they are stripped from the excerpt's own text, so a note body can never forge a
 * highlight.
 */
export const SNIPPET_OPEN = '\uE000';

/**
 * Closing highlight marker; see {@link SNIPPET_OPEN}.
 */
export const SNIPPET_CLOSE = '\uE001';

/**
 * Why a requested link set is unacceptable, or `null` when it is fine.
 *
 * Duplicates are refused rather than silently merged: a client sending the same record twice has a
 * bug the user should not have hidden from them, and the error names the duplicate.
 *
 * @param links The requested links (already shape-validated).
 * @returns A per-field message keyed by `links.<index>`, or `null`.
 */
export function duplicateLink(links: readonly NoteLinkRef[]): Record<string, string> | null {
  const seen = new Set<string>();
  for (const [index, link] of links.entries()) {
    const key = `${link.type}:${link.id}`;
    if (seen.has(key)) {
      return { [`links.${index}`]: 'This record is already linked.' };
    }
    seen.add(key);
  }
  return null;
}

/**
 * Order links canonically: by type (contact, company, deal, project), then id.
 *
 * A canonical order makes the stored set, the audit digest, and the idempotency hash independent of
 * the order a user happened to pick records in.
 *
 * @param links The links.
 * @returns A sorted copy.
 */
export function sortLinks<T extends { readonly type: NoteLinkType; readonly id: string }>(
  links: readonly T[]
): T[] {
  return [...links].sort(
    (a, b) =>
      NOTE_LINK_TYPES.indexOf(a.type) - NOTE_LINK_TYPES.indexOf(b.type)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The difference between two link sets.
 *
 * @param before Links before the change.
 * @param after Links after the change.
 * @returns Links added and removed, each in canonical order.
 */
export function diffLinks(
  before: readonly NoteLinkRef[],
  after: readonly NoteLinkRef[]
): { added: NoteLinkRef[]; removed: NoteLinkRef[] } {
  const key = (link: NoteLinkRef): string => `${link.type}:${link.id}`;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: sortLinks(after.filter((link) => !beforeKeys.has(key(link)))),
    removed: sortLinks(before.filter((link) => !afterKeys.has(key(link))))
  };
}

/**
 * Whether an edit needs `note.manage` (anyone's note) rather than just `note.write`.
 *
 * Authors may edit their own notes; editing someone else's is a manager capability (spec
 * `01d-notesservice-spec.md` §6). The service asks the Permissions module for `note.manage` rather
 * than inspecting roles.
 *
 * @param authorId The note's immutable author.
 * @param actorId The caller.
 * @returns `true` when the caller is not the author.
 */
export function needsNoteManage(authorId: string, actorId: string): boolean {
  return authorId !== actorId;
}

/**
 * Turn free text into a safe FTS5 `MATCH` expression, or `null` when it has no searchable words.
 *
 * The client never supplies FTS syntax. Text is split into runs of Unicode letters and digits, so
 * operators (`AND`, `NEAR`, `-`, `^`, `:`), column filters, and quotes are simply separators. Each
 * token becomes a quoted prefix term (`"pric"*`), and the terms are implicitly ANDed. Quoting means
 * even a token such as `OR` is a literal word, never an operator.
 *
 * @param text Trimmed search text (2–200 characters).
 * @returns The expression, or `null`.
 */
export function ftsQuery(text: string): string | null {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) {
    return null;
  }
  // Letters and digits contain no `"`; the doubling is defence in depth should the token rule ever
  // widen.
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' ');
}

/**
 * Split an FTS5 snippet into plain-text runs, marking the highlighted ones.
 *
 * @param snippet Snippet text bracketed with {@link SNIPPET_OPEN}/{@link SNIPPET_CLOSE}.
 * @returns Adjacent runs; empty runs are dropped.
 */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let match = false;
  let text = '';
  const flush = (): void => {
    if (text !== '') {
      segments.push({ text, match });
    }
    text = '';
  };
  for (const char of snippet) {
    if (char === SNIPPET_OPEN || char === SNIPPET_CLOSE) {
      flush();
      match = char === SNIPPET_OPEN;
    } else {
      text += char;
    }
  }
  flush();
  return segments;
}

/**
 * Remove highlight markers from note text before indexing or display, so stored content cannot
 * imitate a search highlight.
 *
 * @param text Note text.
 * @returns The text without marker characters.
 */
export function stripSnippetMarkers(text: string): string {
  return text.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, '');
}
