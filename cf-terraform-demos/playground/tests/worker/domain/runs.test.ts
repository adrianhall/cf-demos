import { describe, expect, it } from 'vitest';
import { emptySessionCostLedger } from '../../../src/shared/runs';

describe('emptySessionCostLedger', () => {
  it('starts every counter at zero', () => {
    expect(emptySessionCostLedger()).toEqual({
      runCount: 0,
      knownCostUsd: 0,
      pendingRuns: 0,
      unavailableRuns: 0,
      cachedRequests: 0,
      billedRequests: 0
    });
  });

  // The store holds the ledger as mutable state. A shared frozen constant would mean one
  // component's update silently altered every other consumer's view.
  it('returns a fresh object each time', () => {
    expect(emptySessionCostLedger()).not.toBe(emptySessionCostLedger());
  });
});
