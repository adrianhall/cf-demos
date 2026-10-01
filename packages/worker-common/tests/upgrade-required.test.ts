import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { upgradeRequired } from '../src/upgrade-required.ts';

describe('upgradeRequired', () => {
  it('builds a 426 problem-details error carrying the supplied detail', () => {
    const error = upgradeRequired('This endpoint accepts WebSocket connections only.');

    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect(error.problemDetails).toMatchObject({
      detail: 'This endpoint accepts WebSocket connections only.',
      status: 426
    });
  });

  it('returns the error rather than throwing it, so the caller controls the throw site', () => {
    expect(() => upgradeRequired('nope')).not.toThrow();
  });
});
