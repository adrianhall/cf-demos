import { describe, expect, it } from 'vitest';
import { readJsonBody } from '../../../src/worker/lib/read-json-body';
import { problemWithStatus } from '../support/problem-details';

/**
 * Build a POST request carrying a raw body string.
 *
 * @param body Raw request body, valid JSON or otherwise.
 * @returns A request the helper can read.
 */
function requestWith(body: string): Request {
  return new Request('https://todo.example/api/todos', {
    body,
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
}

describe('readJsonBody', () => {
  it('parses a valid JSON object', async () => {
    expect(await readJsonBody(requestWith('{"title":"Buy milk"}'))).toEqual({ title: 'Buy milk' });
  });

  it('parses a non-object JSON value, leaving shape checks to validation', async () => {
    // Shape validation belongs to the domain layer, so this helper only guarantees "it was JSON".
    expect(await readJsonBody(requestWith('"a string"'))).toBe('a string');
  });

  // Without this mapping, malformed JSON would surface as an unhandled SyntaxError and be reported
  // as a 500 — blaming the server for a client mistake.
  it.each([
    ['truncated JSON', '{"title":'],
    ['a bare word', 'undefined'],
    ['an empty body', '']
  ])('maps %s to a 400', async (_label, body) => {
    await expect(readJsonBody(requestWith(body))).rejects.toMatchObject(problemWithStatus(400));
  });
});
