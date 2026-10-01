import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { readJsonBody } from '../src/read-json-body.ts';

/**
 * Build a `POST` request carrying the given raw body text.
 */
function postRequest(body: string): Request {
  return new Request('https://example.com/api/resource', { body, method: 'POST' });
}

describe('readJsonBody', () => {
  it('parses a well-formed JSON object body', async () => {
    await expect(readJsonBody(postRequest(JSON.stringify({ title: 'Buy milk' })))).resolves.toEqual(
      { title: 'Buy milk' }
    );
  });

  it('parses any valid JSON value, not only objects', async () => {
    // Shape validation is a domain concern; this only parses.
    await expect(readJsonBody(postRequest('42'))).resolves.toBe(42);
    await expect(readJsonBody(postRequest('null'))).resolves.toBeNull();
    await expect(readJsonBody(postRequest('[1,2]'))).resolves.toEqual([1, 2]);
  });

  it('rejects malformed JSON with a 400 problem detail', async () => {
    try {
      await readJsonBody(postRequest('{not-json'));
      expect.unreachable('readJsonBody should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemDetailsError);
      expect((error as ProblemDetailsError).problemDetails).toMatchObject({
        detail: 'Request body must contain valid JSON.',
        status: 400
      });
    }
  });

  it('rejects an empty body with a 400 problem detail', async () => {
    await expect(readJsonBody(postRequest(''))).rejects.toBeInstanceOf(ProblemDetailsError);
  });
});
