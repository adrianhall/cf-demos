import { useMemo, useState } from 'react';
import { type Blueprint, BLUEPRINTS } from '../../../blueprints.ts';
import { BlueprintPreview } from './BlueprintPreview.tsx';
import { CreateDiagramModal } from './CreateDiagramModal.tsx';

/**
 * Label for the unfiltered view.
 *
 * Not a category in the data, so it is named once here rather than compared as a literal at each
 * use.
 */
const ALL_CATEGORY = 'All';

/**
 * The public gallery of blueprint templates, plus a permanent blank-canvas card.
 *
 * Every card opens {@link CreateDiagramModal} over this page rather than navigating anywhere. The
 * page itself is public — browsing starting points is useful before signing in — and only the
 * create request the modal sends requires an identity, which Cloudflare Access challenges at that
 * point. The dashboard's create control links here, so there is one creation journey rather than
 * one for a signed-in visitor and another for everybody else.
 *
 * Each card is a single `<button>` wrapping the whole panel: one tab stop, one activation target,
 * and no nested control announcing the same action twice. The thumbnail inside it is inert and
 * `aria-hidden` (see {@link BlueprintPreview}), so it adds nothing to the card's accessible name.
 *
 * @returns The filterable gallery and its creation modal.
 */
export function BlueprintGallery() {
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedBlueprint, setSelectedBlueprint] = useState<Blueprint | null>(null);

  // Derived from the data rather than listed separately, so adding a template with a new category
  // adds its filter automatically instead of leaving it unreachable behind the existing pills.
  const categories = useMemo(
    () => [ALL_CATEGORY, ...new Set(BLUEPRINTS.map((blueprint) => blueprint.category))],
    []
  );

  const filtered =
    activeCategory === ALL_CATEGORY
      ? BLUEPRINTS
      : BLUEPRINTS.filter((blueprint) => blueprint.category === activeCategory);

  /**
   * Opens the creation modal for one card's starting point.
   *
   * @param blueprint Template the visitor chose, or `null` for the blank canvas.
   * @returns Nothing; the modal's visibility is state.
   */
  const openModal = (blueprint: Blueprint | null): void => {
    setSelectedBlueprint(blueprint);
    setModalOpen(true);
  };

  return (
    <>
      <div className="blueprint-gallery__filters" role="tablist" aria-label="Filter by category">
        {categories.map((category) => (
          <button
            type="button"
            key={category}
            role="tab"
            aria-selected={activeCategory === category}
            className={`blueprint-gallery__filter${
              activeCategory === category ? ' blueprint-gallery__filter--active' : ''
            }`}
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="blueprint-gallery__grid">
        {/* Outside the filtered list, because starting from nothing belongs to no category and is
            always a valid choice. A blank-canvas card that vanished when a visitor narrowed to
            "AI" would make the filter look like it had removed an option rather than a subset. */}
        {/* Named by its title alone. Without this the accessible name is the concatenation of the
            title and the description, so a screen-reader user hears a sentence of prose where they
            expected the name of a control. */}
        <button
          type="button"
          className="blueprint-card blueprint-card--blank"
          aria-label="Blank Canvas"
          onClick={() => openModal(null)}
        >
          <div
            className="blueprint-card__preview blueprint-card__preview--blank"
            aria-hidden="true"
          >
            <span>+</span>
          </div>
          <div className="blueprint-card__body">
            <div className="blueprint-card__title">Blank Canvas</div>
            <div className="blueprint-card__description">
              Start from scratch with an empty diagram.
            </div>
          </div>
        </button>

        {filtered.map((blueprint) => (
          <button
            type="button"
            key={blueprint.id}
            className="blueprint-card"
            onClick={() => openModal(blueprint)}
          >
            <div className="blueprint-card__preview">
              <BlueprintPreview graphData={blueprint.graphData} height={180} />
            </div>
            <div className="blueprint-card__body">
              <div className="blueprint-card__title">{blueprint.title}</div>
              <span className="blueprint-card__badge">{blueprint.category}</span>
              <div className="blueprint-card__description">{blueprint.description}</div>
            </div>
          </button>
        ))}
      </div>

      <CreateDiagramModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        blueprint={selectedBlueprint}
      />
    </>
  );
}
