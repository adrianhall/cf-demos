import { describe, expect, it } from 'vitest';
import { readJsonBody } from '../../../src/worker/lib/read-json-body';
import { upgradeRequired } from '../../../src/worker/lib/upgrade-required';
import { problemWithStatus } from '../support/problem-details';

describe('readJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const request = new Request('https://chat.example/api/channels', {
      body: JSON.stringify({ name: 'deploys' }),
      method: 'POST'
    });

    expect(await readJsonBody(request)).toEqual({ name: 'deploys' });
  });

  // Without this, a client's syntax mistake would surface as an unhandled `SyntaxError` and be
  // reported as a 500 — blaming the server for a client error.
  it('reports malformed JSON as 400 rather than letting SyntaxError escape', async () => {
    const request = new Request('https://chat.example/api/channels', {
      body: '{"name":',
      method: 'POST'
    });

    await expect(readJsonBody(request)).rejects.toMatchObject(problemWithStatus(400));
  });

  it('reports an absent body as 400', async () => {
    const request = new Request('https://chat.example/api/channels', { method: 'POST' });
    await expect(readJsonBody(request)).rejects.toMatchObject(problemWithStatus(400));
  });
});

describe('upgradeRequired', () => {
  // 426 rather than 400: the request is well-formed and the resource exists, but it can only be
  // used over a different protocol.
  it('builds a 426 problem carrying the supplied detail', () => {
    const error = upgradeRequired('This endpoint accepts WebSocket connections only.');

    expect(error.problemDetails.status).toBe(426);
    expect(error.problemDetails.detail).toBe('This endpoint accepts WebSocket connections only.');
  });
});
