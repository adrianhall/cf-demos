import { describe, expect, it } from 'vitest';
import {
  IDENTITY_HEADER,
  withVerifiedIdentity
} from '../../../src/worker/infrastructure/room-protocol';

/**
 * Build an upgrade request, optionally carrying headers a client might have sent.
 *
 * @param headers Extra headers to attach.
 * @returns A WebSocket upgrade request.
 */
function upgradeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://chat.example/api/channels/general/socket', {
    headers: { Upgrade: 'websocket', ...headers }
  });
}

/**
 * The room trusts {@link IDENTITY_HEADER} without checking it, so everything that makes that trust
 * sound lives in this function. These tests are the reason it is a named function rather than two
 * lines inlined at the call site: the rule is testable in isolation, and a regression here is a
 * privilege-escalation bug rather than a cosmetic one.
 */
describe('withVerifiedIdentity', () => {
  it('records the verified identity', () => {
    const rewritten = withVerifiedIdentity(upgradeRequest(), 'alice@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('alice@example.com');
  });

  // The attack this prevents: a client sending its own identity header in the hope the room
  // reads it and attributes messages to somebody else.
  it('discards a client-supplied identity header', () => {
    const smuggled = upgradeRequest({ [IDENTITY_HEADER]: 'admin@example.com' });

    const rewritten = withVerifiedIdentity(smuggled, 'mallory@example.com');

    expect(rewritten.headers.get(IDENTITY_HEADER)).toBe('mallory@example.com');
  });

  // Header names are case-insensitive, so a lowercase spelling must be overwritten too —
  // otherwise the check would be trivially evaded.
  it('discards a differently-cased client-supplied header', () => {
    const smuggled = upgradeRequest({ 'x-chat-identity': 'admin@example.com' });

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
      upgradeRequest({ 'Sec-WebSocket-Protocol': 'chat' }),
      'alice@example.com'
    );

    expect(rewritten.headers.get('Sec-WebSocket-Protocol')).toBe('chat');
  });

  it('does not mutate the original request', () => {
    const original = upgradeRequest({ [IDENTITY_HEADER]: 'admin@example.com' });

    withVerifiedIdentity(original, 'mallory@example.com');

    expect(original.headers.get(IDENTITY_HEADER)).toBe('admin@example.com');
  });
});
