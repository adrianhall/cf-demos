/**
 * @file The audit projection's allowlist: only known scalar keys leave the Data Worker, and a
 *   malformed row is redacted rather than breaking the trail.
 */

import { describe, expect, it } from 'vitest';
import { redactMetadata } from '../../../src/data-worker/domain/audit/audit.ts';

describe('redactMetadata', () => {
  it('keeps allowlisted scalars and reports anything removed', () => {
    expect(
      redactMetadata(
        JSON.stringify({ digest: 'a'.repeat(64), linkCount: 2, titleChanged: false, via: null })
      )
    ).toEqual({
      metadata: { digest: 'a'.repeat(64), linkCount: 2, titleChanged: false, via: null },
      redacted: false
    });
    expect(redactMetadata('{"markdown":"secret","fields":"title","status":{"nested":1}}')).toEqual({
      metadata: { fields: 'title' },
      redacted: true
    });
  });

  it('redacts arbitrary text even when it appears under a normally allowed key', () => {
    expect(
      redactMetadata(
        JSON.stringify({
          fields: 'title,private customer comment',
          status: 'Budget is £1.2m',
          linksAdded: 'contact:secret',
          role: 'owner,secret',
          digest: 'raw note body',
          linkCount: 1
        })
      )
    ).toEqual({ metadata: { linkCount: 1 }, redacted: true });
  });

  it('treats malformed or non-object JSON as fully redacted', () => {
    for (const json of ['not json', '[1,2]', '"text"', 'null']) {
      expect(redactMetadata(json), json).toEqual({ metadata: {}, redacted: true });
    }
  });
});
