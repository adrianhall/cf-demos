/**
 * Small avatar stack in the editor toolbar showing every other identity currently connected to
 * this diagram's live-sync session (docs/09C-COLLABORATIVE-EDITING.md's Phase 19, mirroring
 * `docs/BACKLOG.md`'s original demo 9 ask: "each user sees... who else is present"). One avatar
 * per `participants` entry (`../../../hooks/useDiagramLiveSync.ts`), colored with that identity's
 * server-assigned presence color.
 *
 * Not rendered in read-only mode (`../Toolbar.tsx` never renders this component there) and
 * renders nothing at all when no one else is currently connected, rather than an empty list.
 *
 * A `<ul>`/`<li>` list with an `aria-label` gives this stack a real accessible grouping, and each
 * avatar carries its own accessible name (the participant's full email, via `role="img"` +
 * `aria-label`) rather than relying on its background color alone to distinguish one identity
 * from another -- WCAG 2.2 AA color-alone requirements (`AGENTS.md`'s Browser Applications
 * section).
 */
import type { DiagramLiveSync } from "../../../hooks/useDiagramLiveSync";

/**
 * @param email A participant's email address.
 * @returns The uppercased first character of the email's local part (before `@`), or `"?"` for
 * a pathological empty-string email -- legible at avatar size without needing the whole
 * address, matching common avatar-stack conventions.
 */
function initialFor(email: string): string {
  // `String.prototype.split()` always returns at least one element, so `localPart` is always a
  // `string` here (never `undefined`), even for an empty `email`.
  const localPart = email.split("@")[0];
  return localPart.length > 0 ? localPart.charAt(0).toUpperCase() : "?";
}

/**
 * @param participants Every other currently-connected identity, keyed by email --
 * `useDiagramLiveSync()`'s own `participants` map.
 */
export function PresenceStack({
  participants,
}: {
  participants: DiagramLiveSync["participants"];
}) {
  const list = Object.values(participants);
  if (list.length === 0) return null;

  return (
    <ul className="presence-stack" aria-label="Currently viewing">
      {list.map((participant) => (
        <li
          key={participant.email}
          className="presence-stack__item"
          title={participant.email}
        >
          <span
            className="presence-stack__avatar"
            style={{ backgroundColor: participant.color }}
            role="img"
            aria-label={participant.email}
          >
            {initialFor(participant.email)}
          </span>
        </li>
      ))}
    </ul>
  );
}
