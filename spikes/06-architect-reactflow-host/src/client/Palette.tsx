import type { DragEvent } from "react";
import { catalogProducts, externalActor } from "./catalog";

/** `dataTransfer` MIME type used to hand off a dragged palette entry to the canvas's `onDrop`. */
export const PALETTE_DATA_TRANSFER_TYPE = "application/architect-spike-node";

/** Payload encoded into the drag event, decoded by the canvas on drop. */
export interface PaletteDragPayload {
  kind: "product" | "actor";
  label: string;
  color?: string;
}

/**
 * The searchable-in-spirit (search is out of scope for this probe) product palette:
 * CF-Architect's `ServicePalette.tsx`, adapted. Every entry is draggable onto the canvas unless
 * `readOnly` is set, matching the real demo's read-only share viewer having no palette at all.
 */
export function Palette({ readOnly }: { readOnly: boolean }) {
  function handleDragStart(event: DragEvent<HTMLButtonElement>, payload: PaletteDragPayload) {
    event.dataTransfer.setData(PALETTE_DATA_TRANSFER_TYPE, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  }

  if (readOnly) {
    return null;
  }

  return (
    <aside className="palette" aria-label="Product palette">
      <h2 className="palette__heading">Products</h2>
      <ul className="palette__list">
        {catalogProducts.map((product) => (
          <li key={product.id}>
            <button
              type="button"
              className="palette__item"
              draggable
              onDragStart={(event) =>
                handleDragStart(event, {
                  kind: "product",
                  label: product.name,
                  color: product.color,
                })
              }
            >
              <span className="palette__swatch" style={{ backgroundColor: product.color }} />
              {product.name}
              <span className="palette__category">{product.category}</span>
            </button>
          </li>
        ))}
      </ul>
      <h2 className="palette__heading">Actors</h2>
      <ul className="palette__list">
        <li>
          <button
            type="button"
            className="palette__item"
            draggable
            onDragStart={(event) =>
              handleDragStart(event, { kind: "actor", label: externalActor.name })
            }
          >
            {externalActor.name}
          </button>
        </li>
      </ul>
    </aside>
  );
}
