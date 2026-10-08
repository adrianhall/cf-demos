import { describe, expect, it } from 'vitest';
import {
  IDENTITY_HEADER,
  withVerifiedIdentity
} from '../../src/worker/infrastructure/session-protocol.ts';

/**
 * @file The `DiagramSession` Durable Object trusts {@link IDENTITY_HEADER} without checking it, so
 *   everything that makes that trust sound lives in one function. These tests are the reason it is
 *   a named function rather than two lines inlined at the call site: the rule is testable in
 *   isolation, and a regression here is a privilege-escalation bug rather than a cosmetic one. The
 *   same defence is asserted again end to end, through the real route and the real runtime, in
 *   `../integration/live-sync.test.ts` — one of the very few behaviours in this demo worth covering
 *   twice.
 */

/**
 * Builds an upgrade request, optionally carrying headers a client might have sent.
 *
 * @param headers Extra headers to attach.
 * @returns A WebSocket upgrade request to a diagram's live endpoint.
 */
function upgradeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://diagrams.test/api/diagrams/d1/live', {
    headers: { Upgrade: 'websocket', ...headers }
  });
}

describe('withVerifiedIdentity', () => {
  it('records the verified identity', () => {
    const rewritten = withVerifiedIdentity(upgradeRequest(), 'alice@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('alice@example.com');
  });

  // The attack this prevents: a client sending its own identity header in the hope the session
  // reads it and attributes the connection to somebody else.
  it('discards a client-supplied identity header', () => {
    const smuggled = upgradeRequest({ [IDENTITY_HEADER]: 'alice@example.com' });

    const rewritten = withVerifiedIdentity(smuggled, 'mallory@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('mallory@example.com');
  });

  // Header names are case-insensitive, so a lowercase spelling must be overwritten too —
  // otherwise the check would be trivially evaded by changing one character.
  it('discards a differently-cased client-supplied header', () => {
    const smuggled = upgradeRequest({ 'x-architect-identity': 'alice@example.com' });

    const rewritten = withVerifiedIdentity(smuggled, 'mallory@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('mallory@example.com');
  });

  it('discards an upper-cased client-supplied header', () => {
    const smuggled = upgradeRequest({ 'X-ARCHITECT-IDENTITY': 'alice@example.com' });

    const rewritten = withVerifiedIdentity(smuggled, 'mallory@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('mallory@example.com');
  });

  // The Hibernation API completes the protocol switch against the forwarded request, so losing
  // the upgrade header here would break every connection.
  it('preserves the upgrade header the protocol switch depends on', () => {
    const rewritten = withVerifiedIdentity(upgradeRequest(), 'alice@example.com');

    expect(rewritten.headers.get('Upgrade')).toBe('websocket');
  });

  it('leaves unrelated headers intact', () => {
    const rewritten = withVerifiedIdentity(
      upgradeRequest({ 'Sec-WebSocket-Protocol': 'architect' }),
      'alice@example.com'
    );

    expect(rewritten.headers.get('Sec-WebSocket-Protocol')).toBe('architect');
  });

  it('preserves the request URL, which names the diagram being connected to', () => {
    const rewritten = withVerifiedIdentity(upgradeRequest(), 'alice@example.com');

    expect(rewritten.url).toBe('https://diagrams.test/api/diagrams/d1/live');
  });

  it('does not mutate the original request', () => {
    const original = upgradeRequest({ [IDENTITY_HEADER]: 'alice@example.com' });

    withVerifiedIdentity(original, 'mallory@example.com');

    expect(original.headers.get(IDENTITY_HEADER)).toBe('alice@example.com');
  });
});
