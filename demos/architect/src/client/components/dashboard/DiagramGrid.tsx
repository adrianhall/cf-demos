import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagramSummary } from "../../api/diagrams";
import {
  deleteDiagram,
  duplicateDiagram,
  listDiagrams,
} from "../../api/diagrams";
import { useDismissableMenu } from "../../hooks/useDismissableMenu";
import { formatAbsoluteDate, formatRelativeDate } from "../../lib/datetime";
import { BlueprintPreview } from "../blueprints/BlueprintPreview";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

/** Per-card overflow menu: open, duplicate, or delete. */
function CardMenu({
  diagramTitle,
  onDuplicate,
  onDelete,
}: {
  diagramTitle: string;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismissableMenu(
    open,
    menuRef,
    useCallback(() => setOpen(false), []),
  );

  const runAction = (event: React.MouseEvent, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    action();
  };

  return (
    <div className="diagram-card__menu" ref={menuRef}>
      <button
        type="button"
        className="diagram-card__menu-button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${diagramTitle}`}
      >
        ⋮
      </button>
      {open && (
        <div className="diagram-card__dropdown" role="menu">
          <button
            type="button"
            role="menuitem"
            className="diagram-card__dropdown-item"
            onClick={(event) => runAction(event, onDuplicate)}
          >
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className="diagram-card__dropdown-item diagram-card__dropdown-item--danger"
            onClick={(event) => runAction(event, onDelete)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Personal dashboard: a responsive card grid of the signed-in identity's own diagrams, each
 * card linking to its editor and offering duplicate/delete from an overflow menu. Ported from
 * CF-Architect's `src/islands/dashboard/DiagramList.tsx`; renaming happens by opening a diagram
 * and editing its title in the toolbar (`../editor/toolbar/Toolbar.tsx`), matching
 * CF-Architect's own design -- there is no separate rename affordance on the card itself.
 */
export function DiagramGrid() {
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DiagramSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setDiagrams(await listDiagrams());
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load your diagrams.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDuplicate = useCallback(
    async (diagram: DiagramSummary) => {
      await duplicateDiagram(diagram);
      await load();
    },
    [load],
  );

  const confirmDelete = useCallback(async (target: DiagramSummary) => {
    await deleteDiagram(target.id);
    setDiagrams((previous) =>
      previous.filter((diagram) => diagram.id !== target.id),
    );
    setDeleteTarget(null);
  }, []);

  if (loading) {
    return <p className="dashboard__loading">Loading your diagrams…</p>;
  }

  if (loadError) {
    return (
      <p className="dashboard__error" role="alert">
        {loadError}
      </p>
    );
  }

  return (
    <>
      <div className="dashboard__header">
        <h1 className="dashboard__title">My Diagrams</h1>
        {diagrams.length > 0 && (
          <a href="/blueprints" className="button button--primary">
            + New Diagram
          </a>
        )}
      </div>

      {diagrams.length === 0 ? (
        <div className="dashboard__empty">
          <h2>No diagrams yet</h2>
          <p>
            Create your first Cloudflare architecture diagram to get started.
          </p>
          <a href="/blueprints" className="button button--primary">
            + New Diagram
          </a>
        </div>
      ) : (
        <div className="dashboard__grid">
          {diagrams.map((diagram) => (
            // A non-interactive container, not an <a> -- see `.diagram-card`'s Bug 16 comment
            // in `../../app.css`. The title's own <a> is stretched to cover the whole card.
            <div key={diagram.id} className="diagram-card">
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
                  <time
                    className="diagram-card__timestamp"
                    dateTime={diagram.updatedAt}
                    title={`Created ${formatAbsoluteDate(diagram.createdAt)}\nUpdated ${formatAbsoluteDate(diagram.updatedAt)}`}
                  >
                    Updated {formatRelativeDate(diagram.updatedAt)}
                    {/* A native `title` attribute is not reliably exposed to screen readers, so
                        the exact date is repeated here for assistive technology; sighted users
                        still get it from the `title` tooltip on hover/focus. */}
                    <span className="visually-hidden">
                      {" "}
                      ({formatAbsoluteDate(diagram.updatedAt)})
                    </span>
                  </time>
                </div>
                <CardMenu
                  diagramTitle={diagram.title}
                  onDuplicate={() => void handleDuplicate(diagram)}
                  onDelete={() => setDeleteTarget(diagram)}
                />
              </div>
              <div className="diagram-card__preview">
                <BlueprintPreview graphData={diagram.graphData} height={140} />
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          open
          diagramTitle={deleteTarget.title}
          onConfirm={() => void confirmDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
