/**
 * @file Pure notes rules: link duplicate detection, canonical ordering and diffs, the
 *   author-or-manager rule, safe FTS query construction, snippet parsing, and the shared Markdown
 *   size rule.
 */

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  diffLinks,
  duplicateLink,
  ftsQuery,
  MAX_SEARCH_TOKENS,
  needsNoteManage,
  parseSnippet,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  sortLinks,
  stripSnippetMarkers
} from '../../../src/data-worker/domain/notes/notes.ts';
import { NoteMarkdownSchema, utf8Length } from '../../../src/shared/api/notes.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('note links', () => {
  it('names the first duplicate by its index', () => {
    expect(duplicateLink([{ type: 'contact', id: A }])).toBeNull();
    expect(
      duplicateLink([
        { type: 'contact', id: A },
        { type: 'company', id: A },
        { type: 'contact', id: A }
      ])
    ).toEqual({ 'links.2': 'This record is already linked.' });
  });

  it('orders by type then id, and diffs two sets', () => {
    const sorted = sortLinks([
      { type: 'project', id: A },
      { type: 'contact', id: B },
      { type: 'contact', id: A }
    ]);
    expect(sorted).toEqual([
      { type: 'contact', id: A },
      { type: 'contact', id: B },
      { type: 'project', id: A }
    ]);
    expect(
      diffLinks(
        [
          { type: 'contact', id: A },
          { type: 'deal', id: B }
        ],
        [
          { type: 'deal', id: B },
          { type: 'company', id: A }
        ]
      )
    ).toEqual({ added: [{ type: 'company', id: A }], removed: [{ type: 'contact', id: A }] });
  });

  it('needs note.manage only to edit someone else’s note', () => {
    expect(needsNoteManage(A, A)).toBe(false);
    expect(needsNoteManage(A, B)).toBe(true);
  });
});

describe('ftsQuery', () => {
  it('quotes each word as a prefix term, lower-cased', () => {
    expect(ftsQuery('Pricing Café')).toBe('"pricing"* "café"*');
  });

  it('turns operators, quotes, column filters, and punctuation into separators', () => {
    expect(ftsQuery('title:x OR "y" -z')).toBe('"title"* "x"* "or"* "y"* "z"*');
    expect(ftsQuery('NEAR(a b) ^c')).toBe('"near"* "a"* "b"* "c"*');
    expect(ftsQuery('!! -- ""')).toBeNull();
  });

  it('caps the number of terms', () => {
    const words = Array.from({ length: 20 }, (_, index) => `w${index}`).join(' ');
    expect(ftsQuery(words)?.split(' ')).toHaveLength(MAX_SEARCH_TOKENS);
  });
});

describe('snippets', () => {
  it('splits highlighted and plain runs', () => {
    expect(parseSnippet(`we set ${SNIPPET_OPEN}pricing${SNIPPET_CLOSE} today`)).toEqual([
      { text: 'we set ', match: false },
      { text: 'pricing', match: true },
      { text: ' today', match: false }
    ]);
    expect(parseSnippet('')).toEqual([]);
  });

  it('strips markers so stored text cannot forge a highlight', () => {
    expect(stripSnippetMarkers(`a${SNIPPET_OPEN}b${SNIPPET_CLOSE}c`)).toBe('abc');
  });
});

describe('Markdown body rule', () => {
  it('measures UTF-8 bytes after normalising newlines', () => {
    expect(utf8Length('é')).toBe(2);
    expect(v.parse(NoteMarkdownSchema, 'a\r\nb')).toBe('a\nb');
    // 65,536 bytes of CRLF become 32,768 bytes of LF, which fits.
    expect(v.safeParse(NoteMarkdownSchema, `x${'\r\n'.repeat(32_767)}`).success).toBe(true);
    expect(v.safeParse(NoteMarkdownSchema, 'é'.repeat(32_769)).success).toBe(false);
  });
});
