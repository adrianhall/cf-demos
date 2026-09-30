import { describe, expect, it } from 'vitest';
import {
  validateChannelName,
  validateChannelPathName,
  validateCreateChannelInput,
  validatePostMessageInput
} from '../../../src/worker/domain/channel-validation';
import { statusOf } from '../support/problem-details';

describe('validateChannelName', () => {
  it.each([
    ['a simple name', 'general', 'general'],
    ['surrounding whitespace', '  deploys  ', 'deploys'],
    ['mixed case', 'Deploys', 'deploys'],
    ['digits and hyphens', 'team-2-standup', 'team-2-standup'],
    ['the maximum length', 'a'.repeat(32), 'a'.repeat(32)]
  ])('normalizes %s', (_label, input, expected) => {
    expect(validateChannelName(input)).toBe(expected);
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a leading digit', '1team'],
    ['a leading hyphen', '-team'],
    ['spaces inside', 'my team'],
    ['a slash', 'team/sub'],
    ['path traversal', '../other'],
    ['punctuation', 'team!'],
    ['an over-long name', 'a'.repeat(33)]
  ])('rejects %s with 422', (_label, input) => {
    expect(statusOf(() => validateChannelName(input))).toBe(422);
  });

  // Reserved because each would collide with this Worker's own routing if it ever appeared in a
  // path, producing a channel that looks ordinary in the sidebar but is unreachable.
  it.each(['api', 'channels', 'me', 'socket'])('rejects the reserved name %s', (name) => {
    expect(statusOf(() => validateChannelName(name))).toBe(422);
  });

  // Normalization happens before the reserved check, so a differently-cased spelling of a
  // reserved name cannot slip past it.
  it('rejects a reserved name in a different case', () => {
    expect(statusOf(() => validateChannelName('API'))).toBe(422);
  });
});

describe('validateChannelPathName', () => {
  it('normalizes a valid name exactly as validateChannelName does', () => {
    expect(validateChannelPathName('  General ')).toBe('general');
  });

  // 404 rather than 422 on purpose: a caller must not be able to tell a syntactically invalid
  // name from a name that is valid but was never created.
  it.each(['not valid', '../escape', ''])('answers a malformed path name %s with 404', (name) => {
    expect(statusOf(() => validateChannelPathName(name))).toBe(404);
  });
});

describe('validateCreateChannelInput', () => {
  it('accepts a name-only body and normalizes the name', () => {
    expect(validateCreateChannelInput({ name: ' Deploys ' })).toEqual({ name: 'deploys' });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'general'],
    ['a number', 7]
  ])('rejects %s with 400', (_label, body) => {
    expect(statusOf(() => validateCreateChannelInput(body))).toBe(400);
  });

  it('rejects a missing name with 422', () => {
    expect(statusOf(() => validateCreateChannelInput({}))).toBe(422);
  });

  // The client must not be able to choose who a channel is attributed to; the server always
  // takes that from the verified identity.
  it('rejects an attempt to supply createdBy', () => {
    expect(
      statusOf(() =>
        validateCreateChannelInput({ name: 'general', createdBy: 'mallory@example.com' })
      )
    ).toBe(422);
  });
});

describe('validatePostMessageInput', () => {
  it('accepts a body-only frame and trims it', () => {
    expect(validatePostMessageInput({ body: '  hello  ' })).toEqual({ body: 'hello' });
  });

  it('accepts a body at the maximum length', () => {
    const body = 'a'.repeat(2_000);
    expect(validatePostMessageInput({ body })).toEqual({ body });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a bare string', 'hello']
  ])('rejects %s with 400', (_label, frame) => {
    expect(statusOf(() => validatePostMessageInput(frame))).toBe(400);
  });

  it.each([
    ['a missing body', {}],
    ['a non-string body', { body: 42 }],
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: '   ' }],
    ['an over-long body', { body: 'a'.repeat(2_001) }]
  ])('rejects %s with 422', (_label, frame) => {
    expect(statusOf(() => validatePostMessageInput(frame))).toBe(422);
  });

  // The core authorship guarantee expressed as a validation rule: the wire format has no author
  // field, and supplying one is an error rather than something silently discarded.
  it('rejects a frame that tries to supply an author', () => {
    expect(
      statusOf(() =>
        validatePostMessageInput({ body: 'hello', author: 'someone-else@example.com' })
      )
    ).toBe(422);
  });

  it.each([
    ['a null byte', 'hello\u0000world'],
    ['an escape character', 'hello\u001bworld'],
    ['a carriage return', 'hello\rworld']
  ])('rejects %s with 422', (_label, body) => {
    expect(statusOf(() => validatePostMessageInput({ body }))).toBe(422);
  });

  // Ordinary text a participant might plausibly paste must still be accepted — the control
  // character rule is narrow, not a general character allowlist.
  it.each([
    ['punctuation and symbols', 'Ship it! 🚢 — 100% ready?'],
    ['non-Latin script', 'こんにちは、世界'],
    ['markup-looking text', '<script>alert(1)</script>']
  ])('accepts %s', (_label, body) => {
    expect(validatePostMessageInput({ body })).toEqual({ body });
  });
});
