import type { CFNode } from "./types";

/**
 * Editable label/description form for the currently selected node — CF-Architect's
 * `PropertiesPanel.tsx`, adapted. Renders read-only text instead of inputs whenever `readOnly` is
 * set, matching the real demo's read-only share viewer (docs/09-ARCHITECT.md, Phase 0's probe
 * explicitly calls for both an editable and a true read-only mode of this same panel).
 */
export function PropertiesPanel({
  node,
  readOnly,
  onChange,
}: {
  node: CFNode | undefined;
  readOnly: boolean;
  onChange: (patch: Partial<{ label: string; description: string }>) => void;
}) {
  if (!node) {
    return (
      <aside className="properties-panel" aria-label="Properties">
        <p className="properties-panel__empty">Select a node to see its properties.</p>
      </aside>
    );
  }

  if (readOnly) {
    return (
      <aside className="properties-panel" aria-label="Properties">
        <h2 className="properties-panel__heading">{node.data.label}</h2>
        <p className="properties-panel__description">
          {node.data.description || "No description."}
        </p>
      </aside>
    );
  }

  return (
    <aside className="properties-panel" aria-label="Properties">
      <label className="properties-panel__field">
        Label
        <input
          type="text"
          value={node.data.label}
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </label>
      <label className="properties-panel__field">
        Description
        <textarea
          value={node.data.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
    </aside>
  );
}
