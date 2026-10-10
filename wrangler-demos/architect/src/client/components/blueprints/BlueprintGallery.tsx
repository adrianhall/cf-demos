import { useMemo, useState } from "react";
import { Cpu } from "react-feather";
import { BLUEPRINTS, type Blueprint } from "../../../blueprints";
import { BlueprintPreview } from "./BlueprintPreview";
import { CreateDiagramModal } from "./CreateDiagramModal";
import { GenerateWithAiModal } from "./GenerateWithAiModal";

const ALL_CATEGORY = "All";

/**
 * Gallery of blueprint templates plus a "blank canvas" option and a "Generate with AI" option
 * (docs/09D-ARCHITECT-AICHAT.md's "Diagram Generation From A Description") -- the former two
 * open {@link CreateDiagramModal} to name and create a new diagram, the latter opens
 * {@link GenerateWithAiModal} to describe one in plain language instead. Ported from
 * CF-Architect's `src/islands/blueprints/BlueprintGallery.tsx`. Served at the public
 * `/blueprints` route (docs/09-ARCHITECT.md's Access Model) and linked to from the authenticated
 * dashboard's "+ New Diagram" button -- the same page either way; only the subsequent create
 * request requires a signed-in identity.
 */
export function BlueprintGallery() {
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedBlueprint, setSelectedBlueprint] = useState<Blueprint | null>(
    null,
  );
  const [generateModalOpen, setGenerateModalOpen] = useState(false);

  const categories = useMemo(
    () => [
      ALL_CATEGORY,
      ...new Set(BLUEPRINTS.map((blueprint) => blueprint.category)),
    ],
    [],
  );

  const filtered =
    activeCategory === ALL_CATEGORY
      ? BLUEPRINTS
      : BLUEPRINTS.filter((blueprint) => blueprint.category === activeCategory);

  const openModal = (blueprint: Blueprint | null) => {
    setSelectedBlueprint(blueprint);
    setModalOpen(true);
  };

  return (
    <>
      <div
        className="blueprint-gallery__filters"
        role="tablist"
        aria-label="Filter by category"
      >
        {categories.map((category) => (
          <button
            type="button"
            key={category}
            role="tab"
            aria-selected={activeCategory === category}
            className={`blueprint-gallery__filter${
              activeCategory === category
                ? " blueprint-gallery__filter--active"
                : ""
            }`}
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="blueprint-gallery__grid">
        <button
          type="button"
          className="blueprint-card blueprint-card--blank"
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

        <button
          type="button"
          className="blueprint-card blueprint-card--generate"
          onClick={() => setGenerateModalOpen(true)}
        >
          <div
            className="blueprint-card__preview blueprint-card__preview--generate"
            aria-hidden="true"
          >
            <Cpu size={40} />
          </div>
          <div className="blueprint-card__body">
            <div className="blueprint-card__title">Generate with AI</div>
            <div className="blueprint-card__description">
              Describe the architecture you want, and let the assistant build an
              initial diagram for you.
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
              <span className="blueprint-card__badge">
                {blueprint.category}
              </span>
              <div className="blueprint-card__description">
                {blueprint.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      <CreateDiagramModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        blueprint={selectedBlueprint}
      />
      <GenerateWithAiModal
        open={generateModalOpen}
        onClose={() => setGenerateModalOpen(false)}
      />
    </>
  );
}
