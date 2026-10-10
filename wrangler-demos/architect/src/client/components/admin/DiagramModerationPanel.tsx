import { useState } from "react";
import { deleteAnyDiagram, getAnyDiagram } from "../../api/admin";
import type { SharedDiagram } from "../../api/shares";
import { BlueprintPreview } from "../blueprints/BlueprintPreview";
import { ConfirmDeleteModal } from "../dashboard/ConfirmDeleteModal";

/**
 * Diagram moderation tool: given a diagram id (found, for example, via the Cloudflare dashboard's
 * D1 console -- see `README.md`/`DEMO.md`), preview its read-only fields and, if warranted,
 * delete it regardless of owner. Ids are entered manually rather than picked from a per-user
 * list because `GET /api/admin/users` (`../../api/admin.ts`) deliberately reports only a
 * diagram *count* per identity, not the diagrams themselves -- docs/09-ARCHITECT.md Phase 4
 * scopes the user directory to email/display name/count/timestamps only.
 */
export function DiagramModerationPanel() {
  const [diagramId, setDiagramId] = useState("");
  const [diagram, setDiagram] = useState<SharedDiagram | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const handleOpen = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = diagramId.trim();
    if (trimmed.length === 0) return;

    setLoading(true);
    setError(null);
    setDeleted(false);
    try {
      setDiagram(await getAnyDiagram(trimmed));
    } catch (cause) {
      setDiagram(null);
      setError(
        cause instanceof Error ? cause.message : "Could not load that diagram.",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!diagram) return;
    setConfirmOpen(false);
    try {
      await deleteAnyDiagram(diagram.id);
      setDiagram(null);
      setDeleted(true);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete that diagram.",
      );
    }
  };

  return (
    <section className="admin__moderation">
      <h2 className="admin__section-title">Diagram moderation</h2>
      <p className="admin__section-intro">
        Enter a diagram id (visible in the D1 console's <code>diagrams</code>{" "}
        table) to review and, if needed, delete it -- regardless of who owns it.
      </p>
      <form
        className="admin__moderation-form"
        onSubmit={(event) => void handleOpen(event)}
      >
        <label className="admin__moderation-label" htmlFor="admin-diagram-id">
          Diagram id
        </label>
        <div className="admin__moderation-controls">
          <input
            id="admin-diagram-id"
            className="admin__moderation-input"
            type="text"
            value={diagramId}
            onChange={(event) => setDiagramId(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
          <button type="submit" className="button" disabled={loading}>
            {loading ? "Opening…" : "Open"}
          </button>
        </div>
      </form>

      {deleted && (
        <p className="admin__moderation-success" role="status">
          Diagram deleted.
        </p>
      )}
      {error && (
        <p className="admin__moderation-error" role="alert">
          {error}
        </p>
      )}

      {diagram && (
        <div className="admin__moderation-preview">
          <div className="admin__moderation-preview-header">
            <div>
              <h3 className="admin__moderation-preview-title">
                {diagram.title}
              </h3>
              {diagram.description && (
                <p className="admin__moderation-preview-description">
                  {diagram.description}
                </p>
              )}
            </div>
            <button
              type="button"
              className="button button--danger"
              onClick={() => setConfirmOpen(true)}
            >
              Delete diagram
            </button>
          </div>
          <div className="admin__moderation-preview-canvas">
            <BlueprintPreview graphData={diagram.graphData} height={240} />
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        open={confirmOpen}
        diagramTitle={diagram?.title ?? ""}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
