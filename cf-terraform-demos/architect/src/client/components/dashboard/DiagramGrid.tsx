import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { DiagramSummary } from '../../api/diagrams.ts';
import { deleteDiagram, duplicateDiagram, listDiagrams } from '../../api/diagrams.ts';
import { useDismissableMenu } from '../../hooks/useDismissableMenu.ts';
import { ConfirmDeleteModal } from './ConfirmDeleteModal.tsx';
import { DiagramCard } from './DiagramCard.tsx';

/**
 * Props for {@link CardMenu}.
 */
interface CardMenuProps {
  /**
   * Title of the diagram this menu acts on, used in the trigger's accessible name so a screen
   * reader hears which card's actions it has reached rather than a page of identical buttons.
   */
  diagramTitle: string;
  /**
   * Called when the visitor chooses Duplicate.
   */
  onDuplicate: () => void;
  /**
   * Called when the visitor chooses Delete.
   */
  onDelete: () => void;
}

/**
 * Per-card overflow menu offering duplicate and delete.
 *
 * @param props Diagram title and the two actions; see {@link CardMenuProps}.
 * @returns The menu trigger and, while open, its popup.
 */
function CardMenu({ diagramTitle, onDuplicate, onDelete }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismissableMenu(
    open,
    menuRef,
    useCallback(() => setOpen(false), [])
  );

  /**
   * Runs a menu action without letting the click reach the card's stretched title link behind it.
   *
   * Both calls are needed: `preventDefault` stops the overlay anchor navigating, and
   * `stopPropagation` stops the event continuing up to it in the first place. Without them,
   * choosing Delete would open the editor.
   *
   * @param event Click event from the menu item.
   * @param action Action to run once the menu has closed.
   * @returns Nothing.
   */
  const runAction = (event: MouseEvent, action: () => void): void => {
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
          setOpen((previous) => !previous);
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
 * The personal dashboard: a card grid of the signed-in identity's own diagrams.
 *
 * Renaming is deliberately absent from the card. A diagram's title is edited in the editor's own
 * toolbar, where the visitor can see what they are renaming; a rename affordance here would be a
 * second place to change the same field, with the diagram itself off screen.
 *
 * The create control links to `/blueprints` rather than opening a form. Choosing a starting point
 * and naming the diagram are one decision, and the gallery is where the starting points are.
 *
 * @returns The dashboard's heading, its grid or empty state, and its deletion confirmation.
 */
export function DiagramGrid() {
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DiagramSummary | null>(null);

  /**
   * Whether this component is still mounted.
   *
   * A ref rather than a flag inside the effect, because {@link load} is also called from the
   * duplicate handler, long after the mount effect's own closure has gone. Without it, a request
   * that resolves after the visitor has navigated away commits state into a tree that is no longer
   * on screen — React warns, and more to the point the result is discarded work pretending to be a
   * render.
   */
  const mounted = useRef(true);

  const load = useCallback(async () => {
    // The whole outcome is resolved before any state is committed, and every setter below is then
    // called unconditionally. Two things follow: nothing is set synchronously — a synchronous
    // throw from the API module would otherwise start a second render from inside the effect's
    // first — and a reload after a previous failure clears the old error rather than leaving it
    // on screen beside fresh data.
    const outcome = await listDiagrams().then(
      (loaded) => ({ diagrams: loaded, error: null }),
      (error: unknown) => ({
        diagrams: [] as DiagramSummary[],
        error: error instanceof Error ? error.message : 'Could not load your diagrams.'
      })
    );

    if (!mounted.current) {
      return;
    }

    setDiagrams(outcome.diagrams);
    setLoadError(outcome.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const handleDuplicate = useCallback(
    async (diagram: DiagramSummary) => {
      await duplicateDiagram(diagram.id);
      // Reloaded rather than appended locally, so the new card arrives with the server's own id and
      // timestamps and the list keeps the server's ordering.
      await load();
    },
    [load]
  );

  const confirmDelete = useCallback(async (target: DiagramSummary) => {
    await deleteDiagram(target.id);
    // Removed locally rather than by reloading: the visitor just watched the card they deleted, so
    // the list should update at once instead of after a round trip.
    setDiagrams((previous) => previous.filter((diagram) => diagram.id !== target.id));
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
          <p>Create your first Cloudflare architecture diagram to get started.</p>
          <a href="/blueprints" className="button button--primary">
            + New Diagram
          </a>
        </div>
      ) : (
        <div className="dashboard__grid">
          {diagrams.map((diagram) => (
            <DiagramCard
              key={diagram.id}
              diagram={diagram}
              menu={
                <CardMenu
                  diagramTitle={diagram.title}
                  onDuplicate={() => void handleDuplicate(diagram)}
                  onDelete={() => setDeleteTarget(diagram)}
                />
              }
            />
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
