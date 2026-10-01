import { describe, expect, it } from 'vitest';
import { buildGatewayMetadata } from '../../../src/worker/infrastructure/ai/gateway-metadata';

/**
 * A verified Access identity, as `currentIdentity()` would produce it.
 */
const ALICE = { email: 'alice@example.com', sub: 'sub-alice' };

describe('buildGatewayMetadata', () => {
  it('records the panel, the run, the verified email, and the contract version', () => {
    expect(buildGatewayMetadata('chat', 'run-1', ALICE, 3)).toEqual({
      task: 'chat',
      runId: 'run-1',
      user: 'alice@example.com',
      contractVersion: 3
    });
  });

  // The attribution must follow the identity, not the prompt. Two people asking the same question
  // produce two differently attributed logs, which is what makes per-user spending visible in the
  // gateway dashboard at all.
  it('attributes two identities differently for an otherwise identical request', () => {
    const bob = { email: 'bob@example.com', sub: 'sub-bob' };
    const first = buildGatewayMetadata('chat', 'run-1', ALICE, 1);
    const second = buildGatewayMetadata('chat', 'run-1', bob, 1);
    expect(first.user).not.toBe(second.user);
  });

  // An inference request with no attributable user would produce an unaccountable charge against a
  // shared account. Failing is the correct outcome: there is no safe anonymous fallback, and
  // substituting "unknown" would make the gateway dashboard lie rather than go quiet.
  it('refuses to build metadata for an identity with no email', () => {
    expect(() => buildGatewayMetadata('chat', 'run-1', { email: '', sub: 'sub-x' }, 1)).toThrow(
      /verified user/iu
    );
  });

  it('refuses to build metadata for a whitespace-only email', () => {
    expect(() => buildGatewayMetadata('chat', 'run-1', { email: '   ', sub: 'sub-x' }, 1)).toThrow(
      /verified user/iu
    );
  });

  // There is deliberately no parameter through which a request body or header could supply a
  // user. This asserts the shape of the contract itself: the only way to influence the recorded
  // email is to change the verified identity, which a client cannot do.
  it('takes the email only from the actor argument', () => {
    const spoofed = { email: 'alice@example.com', sub: 'sub-alice', user: 'admin@example.com' };
    const metadata = buildGatewayMetadata('chat', 'run-1', spoofed, 1);
    expect(metadata.user).toBe('alice@example.com');
  });

  it('normalises surrounding whitespace on the recorded email', () => {
    const padded = { email: '  alice@example.com  ', sub: 'sub-alice' };
    expect(buildGatewayMetadata('chat', 'run-1', padded, 1).user).toBe('alice@example.com');
  });

  // Prompt text, uploads, and model output must never reach a retained log record. The metadata
  // builder is the only thing that writes to that record, so the absence is assertable here.
  it('records nothing beyond the four declared fields', () => {
    const metadata = buildGatewayMetadata('view-tokens', 'run-9', ALICE, 1);
    expect(Object.keys(metadata).sort()).toEqual(['contractVersion', 'runId', 'task', 'user']);
  });
});
