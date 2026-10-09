import type { ReactNode } from 'react';
import type { DiagramSummary } from '../../api/diagrams.ts';
import { formatAbsoluteDate, formatRelativeDate } from '../../lib/datetime.ts';
import { BlueprintPreview } from '../blueprints/BlueprintPreview.tsx';

/**
 * Props for {@link DiagramCard}.
 */
export interface DiagramCardProps {
  /**
   * Diagram to render.
   */
  diagram: DiagramSummary;
  /**
   * Optional per-card menu, rendered in the card header beside the title.
   */
  menu?: ReactNode;
  /**
   * Optional text naming the diagram's owner, rendered under the title.
   *
   * Set only by the "Shared with me" section (`./SharedWithMeGrid.tsx`). An owned card deliberately
   * leaves it unset rather than rendering "Shared by you": every card in that section belongs to
   * the visitor, so the line would repeat on each one and say nothing.
   */
  ownerBadge?: string;
}

/**
 * One dashboard card: a diagram's title linking to its editor, when it last changed, a live
 * thumbnail of its graph, and an optional menu slot.
 *
 * The card is a non-interactive `<div>`, not an `<a>`. Only the title is a link, stretched by a
 * `::after` overlay to cover the whole card — the "block link" pattern. That is what lets the menu
 * button be a sibling control rather than a `<button>` nested inside an anchor, which is invalid
 * markup and leaves a screen reader describing a button inside a link to the same place.
 *
 * @param props Diagram and optional menu slot; see {@link DiagramCardProps}.
 * @returns The rendered card.
 */
export function DiagramCard({ diagram, menu, ownerBadge }: DiagramCardProps) {
  return (
    <div className="diagram-card">
      <div className="diagram-card__header">
        <div className="diagram-card__heading">
          <div className="diagram-card__title">
            <a href={`/app/diagram/${diagram.id}`} className="diagram-card__link">
              {diagram.title}
            </a>
          </div>
          {/* Above the timestamp rather than beside the title: whose diagram this is matters more
              to a reader scanning the section than when it last changed, and stacking keeps a long
              address from pushing the title's link out of the card. */}
          {ownerBadge !== undefined && (
            <span className="diagram-card__owner-badge">{ownerBadge}</span>
          )}
          <time
            className="diagram-card__timestamp"
            dateTime={diagram.updatedAt}
            title={`Created ${formatAbsoluteDate(diagram.createdAt)}\nUpdated ${formatAbsoluteDate(diagram.updatedAt)}`}
          >
            Updated {formatRelativeDate(diagram.updatedAt)}
            {/* A `title` attribute is not reliably announced, so the exact date is repeated for
                assistive technology. A sighted visitor still gets it from the tooltip. */}
            <span className="visually-hidden"> ({formatAbsoluteDate(diagram.updatedAt)})</span>
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
