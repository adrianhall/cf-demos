import { type FormEvent, useState } from 'react';
import { deleteAnyDiagram, getAnyDiagram } from '../../api/admin.ts';
import type { SharedDiagram } from '../../api/shares.ts';
import { BlueprintPreview } from '../blueprints/BlueprintPreview.tsx';
import { ConfirmDeleteModal } from '../dashboard/ConfirmDeleteModal.tsx';

/**
 * Diagram moderation: look at a diagram by id, and delete it if it warrants deleting.
 *
 * **Ids are typed in rather than picked from a list, and that is the design.** The directory beside
 * this panel deliberately reports a count per identity rather than the diagrams themselves, so
 * there is no per-user diagram list to click through — which is exactly what stops the
 * administrative surface becoming a browser for everybody's content. An id reaches an operator the
 * way a complaint does: out of band, or from the D1 console. Acting on one is then a deliberate,
 * individually-logged act against a named diagram rather than browsing.
 *
 * The preview is the same read-only canvas the dashboard and gallery use, rendering the same
 * owner-blind projection an anonymous share viewer receives — so an administrator can see what a
 * diagram _contains_ before deleting it without being told whose it is.
 *
 * @returns The moderation form, its preview, and the deletion confirmation.
 */
export function DiagramModerationPanel() {
  const [diagramId, setDiagramId] = useState('');
  const [diagram, setDiagram] = useState<SharedDiagram | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);

  /**
   * Loads the diagram named in the field.
   *
   * @param event Submit event from the form, whose default navigation is prevented.
   * @returns A promise fulfilled once the diagram is on screen or the failure reported.
   */
  const handleOpen = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = diagramId.trim();
    if (trimmed.length === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    // Cleared here rather than left to linger: a success message from a previous deletion sitting
    // above a freshly opened diagram reads as though *this* one has been deleted.
    setDeleted(false);
    try {
      setDiagram(await getAnyDiagram(trimmed));
    } catch (cause) {
      setDiagram(null);
      setError(cause instanceof Error ? cause.message : 'Could not load that diagram.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Deletes the previewed diagram once the confirmation has been accepted.
   *
   * @returns A promise fulfilled once the diagram is gone or the failure reported.
   */
  const handleConfirmDelete = async (): Promise<void> => {
    // Defensive: the dialog tracks its own open state, so a diagram cleared while it was on
    // screen would otherwise reach this with nothing to delete.
    if (diagram === null) {
      return;
    }

    setConfirmOpen(false);
    try {
      await deleteAnyDiagram(diagram.id);
      setDiagram(null);
      setDeleted(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete that diagram.');
    }
  };

  return (
    <section className="admin__moderation">
      <h2 className="admin__section-title">Diagram moderation</h2>
      <p className="admin__section-intro">
        Enter a diagram id (visible in the D1 console&rsquo;s <code>diagrams</code> table) to review
        and, if needed, delete it — regardless of who owns it.
      </p>
      <form className="admin__moderation-form" onSubmit={(event) => void handleOpen(event)}>
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
            {loading ? 'Opening…' : 'Open'}
          </button>
        </div>
      </form>

      {/* An `<output>`, which carries the `status` role natively — announced politely rather
          than as an alert, because a completed deletion is the outcome the operator asked for
          rather than an interruption. The same element the editor's status bar uses, for the
          same reason. */}
      {deleted && <output className="admin__moderation-success">Diagram deleted.</output>}
      {error && (
        <p className="admin__moderation-error" role="alert">
          {error}
        </p>
      )}

      {diagram && (
        <div className="admin__moderation-preview">
          <div className="admin__moderation-preview-header">
            <div>
              <h3 className="admin__moderation-preview-title">{diagram.title}</h3>
              {diagram.description && (
                <p className="admin__moderation-preview-description">{diagram.description}</p>
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

      {/* The same confirmation the owner's own delete uses. Moderation is unrecoverable in
          exactly the same way, so it gets exactly the same interruption rather than a quieter
          one on the grounds that an operator ought to know what they are doing. */}
      <ConfirmDeleteModal
        open={confirmOpen}
        diagramTitle={diagram?.title ?? ''}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
