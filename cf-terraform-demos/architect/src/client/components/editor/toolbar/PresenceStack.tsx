import type { PresenceParticipant } from '../../../../live-sync-protocol.ts';

/**
 * Props for {@link PresenceStack}.
 */
export interface PresenceStackProps {
  /**
   * Other identities currently connected to this diagram.
   */
  participants: PresenceParticipant[];
}

/**
 * Returns a compact readable avatar initial for an email address.
 *
 * @param email Verified email address from the presence protocol.
 * @returns Uppercase local-part initial, or `?` for an impossible empty value.
 */
function initialFor(email: string): string {
  const localPart = email.split('@')[0] ?? '';
  return localPart.length > 0 ? (localPart[0]?.toUpperCase() ?? '?') : '?';
}

/**
 * Shows the other identities currently viewing this diagram.
 *
 * Presence is intentionally a small list rather than a second collaborator-management control: this
 * says who is here now, while the owner-only dialog says who is allowed to edit. Names and colours
 * arrive only from the authenticated session, never from browser-supplied display data.
 *
 * @param props Participant list from the live session.
 * @returns An accessible avatar list, or `null` when this editor is alone.
 */
export function PresenceStack({ participants }: PresenceStackProps) {
  if (participants.length === 0) {
    return null;
  }

  return (
    <ul className="presence-stack" aria-label="Currently viewing this diagram">
      {participants.map((participant) => (
        <li key={participant.email} title={participant.email}>
          <span
            aria-label={participant.email}
            className="presence-stack__avatar"
            style={{ backgroundColor: participant.color }}
          >
            {initialFor(participant.email)}
          </span>
        </li>
      ))}
    </ul>
  );
}
