import type { ReactNode } from "react";
import type { DiagramSummary } from "../../api/diagrams";
import { formatAbsoluteDate, formatRelativeDate } from "../../lib/datetime";
import { BlueprintPreview } from "../blueprints/BlueprintPreview";

/**
 * One dashboard card: a diagram's title (linking to its editor), last-updated timestamp,
 * live-thumbnail preview, and an optional per-card menu/badge slot. Extracted from
 * `./DiagramGrid.tsx` (docs/09C-COLLABORATIVE-EDITING.md's Client section) so
 * `./SharedWithMeGrid.tsx` can render the identical card markup/CSS classes for the dashboard's
 * "Shared with me" section without duplicating this JSX -- the only difference between the two
 * sections is which slots they pass: `./DiagramGrid.tsx` passes `menu` (duplicate/delete, owner
 * actions), `./SharedWithMeGrid.tsx` passes `ownerBadge` instead.
 *
 * @param diagram Diagram to render.
 * @param menu Optional per-card overflow menu, rendered in the card header. Omitted entirely
 * for a diagram the viewer does not own.
 * @param ownerBadge Optional "Shared by \<email\>" badge, rendered only in the dashboard's
 * "Shared with me" section -- a diagram the viewer owns never renders one.
 */
export function DiagramCard({
  diagram,
  menu,
  ownerBadge,
}: {
  diagram: DiagramSummary;
  menu?: ReactNode;
  ownerBadge?: string;
}) {
  return (
    // A non-interactive container, not an <a> -- see `.diagram-card`'s Bug 16 comment in
    // `../../app.css`. The title's own <a> is stretched to cover the whole card.
    <div className="diagram-card">
      <div className="diagram-card__header">
        <div className="diagram-card__heading">
          <div className="diagram-card__title">
            <a
              href={`/app/diagram/${diagram.id}`}
              className="diagram-card__link"
            >
              {diagram.title}
            </a>
          </div>
          {ownerBadge !== undefined && (
            <span className="diagram-card__owner-badge">
              Shared by {ownerBadge}
            </span>
          )}
          <time
            className="diagram-card__timestamp"
            dateTime={diagram.updatedAt}
            title={`Created ${formatAbsoluteDate(diagram.createdAt)}\nUpdated ${formatAbsoluteDate(diagram.updatedAt)}`}
          >
            Updated {formatRelativeDate(diagram.updatedAt)}
            {/* A native `title` attribute is not reliably exposed to screen readers, so the
                exact date is repeated here for assistive technology; sighted users still get it
                from the `title` tooltip on hover/focus. */}
            <span className="visually-hidden">
              {" "}
              ({formatAbsoluteDate(diagram.updatedAt)})
            </span>
          </time>
        </div>
        {menu}
      </div>
      <div className="diagram-card__preview">
        <BlueprintPreview graphData={diagram.graphData} height={140} />
      </div>
    </div>
  );
}
