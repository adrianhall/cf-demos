import { useCallback, useEffect, useState } from "react";
import { listSharedWithMe } from "../../api/collaborators";
import type { DiagramSummary } from "../../api/diagrams";
import { DiagramCard } from "./DiagramCard";

/**
 * Dashboard "Shared with me" section: a responsive card grid of diagrams the signed-in identity
 * collaborates on (never diagrams it owns), each card annotated with a "Shared by \<owner\>"
 * badge (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model Client section). Reuses
 * `./DiagramCard.tsx`'s markup/CSS classes rather than duplicating `./DiagramGrid.tsx` -- the
 * only difference is that a shared card has no owner-only overflow menu (duplicate/delete are
 * not offered here; managing this diagram's collaborators, including "Leave diagram", lives in
 * `../editor/toolbar/CollaboratorsModal.tsx`, opened from within the diagram's own editor).
 */
export function SharedWithMeGrid() {
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDiagrams(await listSharedWithMe());
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load diagrams shared with you.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      className="dashboard__shared-section"
      aria-labelledby="shared-with-me-heading"
    >
      <div className="dashboard__header">
        <h2 id="shared-with-me-heading" className="dashboard__title">
          Shared with me
        </h2>
      </div>

      {loading && (
        <p className="dashboard__loading">Loading shared diagrams…</p>
      )}

      {!loading && loadError && (
        <p className="dashboard__error" role="alert">
          {loadError}
        </p>
      )}

      {!loading && !loadError && diagrams.length === 0 && (
        <div className="dashboard__empty">
          <p>No one has shared a diagram with you yet.</p>
        </div>
      )}

      {!loading && !loadError && diagrams.length > 0 && (
        <div className="dashboard__grid">
          {diagrams.map((diagram) => (
            <DiagramCard
              key={diagram.id}
              diagram={diagram}
              ownerBadge={diagram.ownerEmail}
            />
          ))}
        </div>
      )}
    </section>
  );
}
