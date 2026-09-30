'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { classifyAttributeValue, isMissing } from '../domain/attribute-value';
import {
  ENTITY_TYPES,
  PROVENANCE_ATTRIBUTES,
  type EntityTypeDescriptor,
  type EntityTypeId,
  type RelationDescriptor
} from '../domain/entity-types';
import { scalarText } from '../domain/scalar-text';
import {
  MISSING_RECORD_MESSAGE,
  type EntityRecord,
  type EntitySummary
} from '../state/catalog-store';
import { visibleTrail, type TrailStep } from '../state/trail';
import { useEntity, useRetry } from '../state/use-catalog';

/**
 * Props for {@link EntityDetail}.
 */
export interface EntityDetailProps {
  /**
   * Type of the open entity, or `null` at the welcome state.
   */
  typeId: EntityTypeId | null;
  /**
   * Identifier of the open entity, or `null` when only a collection is selected.
   */
  entityId: string | null;
  /**
   * The path the user took to get here.
   */
  trail: readonly TrailStep[];
  /**
   * Whether the next render should move focus to the heading.
   *
   * A mutable ref rather than a prop value, because it records a one-shot intent registered at the
   * moment of a click. Focus must move after a user-initiated navigation but not on first load or
   * on browser back/forward, and only the handler that performed the navigation knows which this
   * is. The ref is cleared once acted on.
   */
  focusHeading: RefObject<boolean>;
  /**
   * Called when the user picks an entity from a relation panel.
   *
   * @param typeId Type of the chosen entity.
   * @param item Summary of the chosen entity.
   */
  onSelect: (typeId: EntityTypeId, item: EntitySummary) => void;
  /**
   * Called when the user clicks a breadcrumb segment.
   *
   * @param index Position in the trail that was clicked.
   */
  onReturnTo: (index: number) => void;
}

/**
 * Whether a value from a record is an entity object rather than a scalar or null.
 *
 * @param value Field value from a GraphQL record.
 * @returns `true` when the value is an object carrying a string `id`.
 */
function isRecord(value: unknown): value is EntityRecord {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).id === 'string'
  );
}

/**
 * Extract the summaries a relation panel lists.
 *
 * Handles both relation shapes uniformly, which is the point: a single-valued relation becomes a
 * list of zero or one, so the caller reasons about counts rather than about two kinds of relation —
 * while still presenting the two differently, per UISPEC §6.3.
 *
 * @param entity Record the relation belongs to.
 * @param relation Relation being read.
 * @returns Summaries in the order the API returned them; empty for an absent or null relation.
 */
function relationItems(entity: EntityRecord, relation: RelationDescriptor): EntitySummary[] {
  const raw = entity[relation.field];
  const records = relation.single ? (raw == null ? [] : [raw]) : Array.isArray(raw) ? raw : [];
  const target = ENTITY_TYPES[relation.target];

  return records.filter(isRecord).map((record) => ({
    id: record.id,
    title: scalarText(record[target.displayField]),
    subtitle: scalarText(record[target.subtitleField])
  }));
}

/**
 * The widest column: an entity's breadcrumb, attributes, and relation panels.
 *
 * Every type is rendered by this one component, driven by its descriptor. Six per-type detail
 * components would be six copies of one layout drifting apart, and UISPEC §6.3's central warning is
 * that relations differ by type and the UI must not assume otherwise — which is far easier to
 * honour when a missing relation is simply an absent descriptor entry that no component has to
 * remember.
 *
 * @param props Selection, trail, focus intent, and callbacks.
 * @returns The detail column.
 */
export function EntityDetail({
  typeId,
  entityId,
  trail,
  focusHeading,
  onSelect,
  onReturnTo
}: EntityDetailProps): React.JSX.Element {
  const state = useEntity(typeId, entityId);
  const retry = useRetry(typeId, entityId);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const descriptor = typeId === null ? null : ENTITY_TYPES[typeId];
  const entity = state.value;

  // Selecting an entity replaces this column's contents, so focus cannot be left on the element
  // that triggered it — that element no longer exists. Moving it to the new heading is the
  // conventional answer (UISPEC §14) and gives a screen-reader user the name of what they just
  // opened. The heading is only focusable programmatically (`tabIndex={-1}`), so this adds nothing
  // to the tab order.
  useEffect(() => {
    if (focusHeading.current && entity !== null && headingRef.current !== null) {
      focusHeading.current = false;
      headingRef.current.focus();
    }
  }, [entity, focusHeading]);

  return (
    <main aria-label="Record detail" className="detail">
      {/*
        Replacing this column is a significant change with no page navigation, so assistive
        technology has to be told or the change is silent (UISPEC §14). The live region wraps the
        whole column rather than the heading alone, so an error or an empty state is announced too.
      */}
      <div aria-live="polite" className="detail-inner">
        {descriptor === null ? (
          <WelcomePanel />
        ) : entityId === null ? (
          <CollectionPrompt descriptor={descriptor} />
        ) : state.loading ? (
          <p className="empty-note" role="status">
            Loading record…
          </p>
        ) : entity === null ? (
          <div className="panel-error" role="alert">
            <p>{state.error ?? 'That record could not be loaded.'}</p>
            {/* A record that no longer exists cannot be retried into existence, so the button is
                offered only for failures that might be transient (UISPEC §9.4). */}
            {state.error !== MISSING_RECORD_MESSAGE && (
              <button type="button" className="secondary" onClick={retry}>
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            <Breadcrumb trail={trail} onReturnTo={onReturnTo} />
            <header className="detail-header">
              <p className="eyebrow">{descriptor.singular}</p>
              <h1 ref={headingRef} tabIndex={-1}>
                {scalarText(entity[descriptor.displayField], 'Unnamed record')}
              </h1>
              {/* The episode number is part of how a film is identified, not an incidental
                  attribute, so it belongs in the header (UISPEC §6.1). */}
              {descriptor.id === 'films' && (
                <p className="episode">Episode {scalarText(entity.episodeId)}</p>
              )}
            </header>

            {descriptor.attributeGroups.map((group) => (
              <section className="attribute-group" key={group.title ?? 'overview'}>
                {group.title !== null && <h2 className="section-heading">{group.title}</h2>}
                <dl className="attributes">
                  {group.attributes.map((attribute) => {
                    const value = classifyAttributeValue(scalarText(entity[attribute.field]));
                    const classNames = [
                      isMissing(value) ? 'missing' : '',
                      attribute.longForm === true ? 'long-form' : ''
                    ]
                      .filter((name) => name.length > 0)
                      .join(' ');

                    return (
                      <div className="attribute" key={attribute.field}>
                        <dt>{attribute.label}</dt>
                        <dd className={classNames.length > 0 ? classNames : undefined}>
                          {value.text}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}

            <section aria-label="Connections" className="relations">
              {descriptor.relations.map((relation) => (
                <RelationPanel
                  key={relation.field}
                  relation={relation}
                  items={relationItems(entity, relation)}
                  onSelect={onSelect}
                />
              ))}
            </section>

            <ProvenancePanel entity={entity} />
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The first-load state: what this dataset is, and how to start.
 *
 * The detail column is the largest area on screen and must not be blank on arrival (UISPEC §9.1).
 * It is also the natural place to hand a curious visitor over to GraphiQL (§11).
 *
 * @returns The welcome panel.
 */
function WelcomePanel(): React.JSX.Element {
  return (
    <div className="welcome">
      <p className="eyebrow">The Star Wars dataset</p>
      <h1>Follow the connections.</h1>
      <p>
        Six collections — films, people, planets, species, starships, and vehicles — all joined to
        one another. Choose one on the left, or search everything from the banner, then follow
        wherever a record leads.
      </p>
      <p>
        Every record on screen comes from the GraphQL API this demo serves. To write the queries
        yourself, open the console.
      </p>
      <a className="button secondary" href="/graphql">
        Open GraphiQL
      </a>
    </div>
  );
}

/**
 * The state after choosing a collection but before opening a record.
 *
 * @param props The selected type's descriptor.
 * @returns The prompt panel.
 */
function CollectionPrompt({ descriptor }: { descriptor: EntityTypeDescriptor }): React.JSX.Element {
  return (
    <div className="welcome">
      <p className="eyebrow">{descriptor.label}</p>
      <h1>Choose a {descriptor.singular.toLocaleLowerCase()}.</h1>
      <p>
        The collection is ready beside this panel. Select a record to see its details and everything
        it connects to.
      </p>
    </div>
  );
}

/**
 * The path the user actually took, with every segment clickable.
 *
 * A `nav` landmark containing an ordered list, because the breadcrumb is a navigation landmark and
 * the order is meaningful (UISPEC §14). Long trails are elided in the middle, preserving the origin
 * and the most recent steps — the two ends a user reasons about (§7).
 *
 * @param props The trail and the return callback.
 * @returns The breadcrumb, or nothing when there is no path to show.
 */
function Breadcrumb({
  trail,
  onReturnTo
}: {
  trail: readonly TrailStep[];
  onReturnTo: (index: number) => void;
}): React.JSX.Element | null {
  if (trail.length === 0) {
    return null;
  }

  const segments = visibleTrail(trail);

  return (
    <nav aria-label="Exploration path" className="breadcrumb">
      <ol>
        {segments.map((segment) =>
          segment.kind === 'ellipsis' ? (
            <li key="ellipsis" className="breadcrumb-ellipsis">
              <span aria-hidden="true">…</span>
              <span className="sr-only">{segment.hidden} earlier steps hidden</span>
            </li>
          ) : (
            <li key={`${segment.step.typeId}:${segment.step.entityId ?? 'collection'}`}>
              <button
                type="button"
                className="breadcrumb-step"
                aria-current={segment.index === trail.length - 1 ? 'page' : undefined}
                onClick={() => onReturnTo(segment.index)}
              >
                {segment.step.label}
              </button>
            </li>
          )
        )}
      </ol>
    </nav>
  );
}

/**
 * One relation, as a collapsible panel stating how many and listing which.
 *
 * This is the mechanism that makes the explorer an explorer, so it takes some care:
 *
 * - The **count is visible without expanding**, because it is often the interesting fact by itself —
 *   that a planet has ten residents, or a character appears in four films.
 * - It is a native `details`/`summary`, which gives correct expanded/collapsed state to assistive
 *   technology and full keyboard operation without any ARIA of its own.
 * - It is **collapsed by default**: a type may have five relations, and expanding all of them at once
 *   buries the attributes above (UISPEC §6.3).
 * - An **empty relation states so positively** rather than rendering as blank space, and a null
 *   single-valued relation says which relation is missing (§9.3).
 *
 * @param props The relation descriptor, its resolved entries, and the selection callback.
 * @returns The relation panel.
 */
function RelationPanel({
  relation,
  items,
  onSelect
}: {
  relation: RelationDescriptor;
  items: EntitySummary[];
  onSelect: (typeId: EntityTypeId, item: EntitySummary) => void;
}): React.JSX.Element {
  return (
    // `aria-label` duplicates the summary text on purpose. A `details` element takes its
    // accessible name from its `summary`, but that is computed from the summary's full contents —
    // which here include the count badge, so the panel would announce as "Appears in 4". Naming
    // it explicitly keeps the relationship itself as the name and leaves the count as detail.
    <details className="relation-panel" aria-label={relation.label}>
      <summary>
        <span className="relation-label">{relation.label}</span>
        {/* A single-valued relation is one entity or nothing, so a count of "1" would be noise.
            Multi-valued relations always show theirs, including zero. */}
        {relation.single !== true && <span className="relation-count">{items.length}</span>}
      </summary>
      {items.length === 0 ? (
        <p className="empty-relation">{relation.emptyLabel}</p>
      ) : (
        <ul className="relation-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="entity-row"
                onClick={() => onSelect(relation.target, item)}
              >
                <span className="entity-row-title">{item.title}</span>
                <span className="entity-row-subtitle">{item.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * Record-level fields, behind a disclosure.
 *
 * `created`, `edited`, and `url` describe the _record_ rather than its subject, so UISPEC §6.2
 * keeps them visually subordinate rather than dropping them: `url` usefully links to the canonical
 * upstream resource. The identifier is included here too — it is not an attribute of the subject,
 * but someone who wants to use it in GraphiQL needs to be able to find it.
 *
 * @param props The loaded record.
 * @returns The provenance disclosure.
 */
function ProvenancePanel({ entity }: { entity: EntityRecord }): React.JSX.Element {
  return (
    <details className="provenance">
      <summary>Record details</summary>
      <dl className="attributes">
        {PROVENANCE_ATTRIBUTES.map((attribute) => {
          const value = scalarText(entity[attribute.field]);
          return (
            <div className="attribute" key={attribute.field}>
              <dt>{attribute.label}</dt>
              <dd className="provenance-value">
                {attribute.field === 'url' ? (
                  <a href={value} rel="noreferrer" target="_blank">
                    {value}
                  </a>
                ) : (
                  value
                )}
              </dd>
            </div>
          );
        })}
        <div className="attribute">
          <dt>Identifier</dt>
          <dd className="provenance-value">
            <code>{entity.id}</code>
          </dd>
        </div>
      </dl>
    </details>
  );
}
