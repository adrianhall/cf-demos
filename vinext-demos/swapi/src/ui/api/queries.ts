/**
 * @file GraphQL documents, generated from the type descriptors rather than written by hand. Six
 *   types times three query shapes is eighteen documents to keep in step with the UI. Building them
 *   from the same descriptors the components render (see `../domain/entity-types.ts`) means the
 *   fields requested and the fields displayed cannot drift apart — UISPEC §15's "request only what
 *   is displayed" becomes a property of the code rather than a rule someone has to remember while
 *   editing two files.
 *
 *   ## Query shape follows view shape
 *
 *   There are exactly three shapes because there are three things the UI displays:
 *
 *   - a **list row** needs a name and one line of context;
 *   - a **detail view** needs every attribute plus every relation, in one operation;
 *   - a **search** needs list rows from all six collections at once. Each is one round trip. The API
 *     resolves relations in a bounded number of D1 statements whatever the query's breadth, so
 *     asking for a whole detail view at once costs a handful of statements, while issuing one
 *     request per relation panel would waste exactly the batching the API was built to provide.
 */

import {
  ENTITY_TYPES,
  ENTITY_TYPE_IDS,
  PROVENANCE_ATTRIBUTES,
  type EntityTypeDescriptor
} from '../domain/entity-types';

/**
 * Per-parent cap applied to relation lists in a detail query.
 *
 * The API accepts 1–100 and rejects anything outside that range. 100 is chosen rather than a
 * smaller preview size because it exceeds every relation in this dataset — the largest is a film's
 * character list at fewer than 40 — so every panel shows a complete list and no count can be a lie.
 * A larger dataset would want a genuine preview size here and a "show all" affordance; at this size
 * that machinery would be inert.
 */
export const RELATION_LIMIT = 100;

/**
 * Fields identifying an entity in a list row or relation entry.
 *
 * `id` is needed to navigate, and the two display fields are what the row shows. Nothing else:
 * fetching every scalar to render a two-line row is precisely the waste UISPEC §15 warns against.
 *
 * @param descriptor Type whose summary fields are needed.
 * @returns A selection set, deduplicated in case the subtitle repeats the display field.
 */
function summarySelection(descriptor: EntityTypeDescriptor): string {
  const fields = new Set(['id', descriptor.displayField, descriptor.subtitleField]);
  return [...fields].join(' ');
}

/**
 * Every scalar field a detail view renders, including provenance.
 *
 * @param descriptor Type whose attributes are needed.
 * @returns A selection set covering the identifier, the display fields, every grouped attribute,
 *   and the provenance fields.
 */
function attributeSelection(descriptor: EntityTypeDescriptor): string {
  const fields = new Set(['id', descriptor.displayField, descriptor.subtitleField]);
  for (const group of descriptor.attributeGroups) {
    for (const attribute of group.attributes) {
      fields.add(attribute.field);
    }
  }
  for (const attribute of PROVENANCE_ATTRIBUTES) {
    fields.add(attribute.field);
  }

  return [...fields].join(' ');
}

/**
 * The relation part of a detail query.
 *
 * Single-valued relations take no arguments and select one nested object; multi-valued ones take
 * the per-parent limit. Each nested selection is only a summary, because a relation panel shows
 * rows rather than full records — the full record is fetched when the user navigates to it, and by
 * then it is usually already cached.
 *
 * @param descriptor Type whose relations are needed.
 * @returns A selection set for every relation the type has, which for some types is none of the
 *   shapes another type uses.
 */
function relationSelection(descriptor: EntityTypeDescriptor): string {
  return descriptor.relations
    .map((relation) => {
      const target = ENTITY_TYPES[relation.target];
      const args = relation.single ? '' : `(first: ${RELATION_LIMIT})`;
      return `${relation.field}${args} { ${summarySelection(target)} }`;
    })
    .join(' ');
}

/**
 * Build the query loading one collection's list rows, optionally filtered.
 *
 * The search term is a GraphQL variable rather than part of the document, which keeps the document
 * constant per type — so it is parsed once and cached by the server — and means a term containing
 * quotes or braces is just text.
 *
 * @param descriptor Collection to load.
 * @returns A document taking an optional `$search` and returning summary rows.
 */
export function collectionQuery(descriptor: EntityTypeDescriptor): string {
  return `query Collection($search: String) {
  items: ${descriptor.collectionField}(search: $search) { ${summarySelection(descriptor)} }
}`;
}

/**
 * Build the query loading one entity's full detail view.
 *
 * One operation for the whole view — attributes and every relation together — because that is one
 * round trip and a bounded number of statements. The singular root field returns `null` for an
 * unknown identifier rather than erroring, which is what lets a stale shared URL render a "not
 * found" view instead of a failure.
 *
 * @param descriptor Type of the entity to load.
 * @returns A document taking `$id` and returning the entity, or `null`.
 */
export function detailQuery(descriptor: EntityTypeDescriptor): string {
  const singularField = singularRootField(descriptor);
  return `query Detail($id: ID!) {
  entity: ${singularField}(id: $id) {
    ${attributeSelection(descriptor)}
    ${relationSelection(descriptor)}
  }
}`;
}

/**
 * Root field returning a single entity of this type.
 *
 * Derived from the collection field rather than stored, since the two are mechanically related:
 * `people` → `person`, `speciesList` → `species`. Species is the awkward one in both directions,
 * which is exactly why this mapping is explicit rather than a naive de-pluralisation.
 *
 * @param descriptor Type whose singular field is needed.
 * @returns The GraphQL root field name.
 */
function singularRootField(descriptor: EntityTypeDescriptor): string {
  const singularByCollection: Readonly<Record<string, string>> = {
    films: 'film',
    people: 'person',
    planets: 'planet',
    speciesList: 'species',
    starships: 'starship',
    vehicles: 'vehicle'
  };

  return singularByCollection[descriptor.collectionField] ?? descriptor.collectionField;
}

/**
 * Build the cross-type search query: all six collections filtered by one term.
 *
 * This is UISPEC §12.2 in practice, and it needs no API surface beyond the per-collection `search`
 * argument — one operation selecting six aliased fields does the whole job.
 *
 * It deliberately requests **summary fields only, and no relations**. Six collections of three
 * scalars is around 25 fields, comfortably inside the schema's 50-field breadth limit and its depth
 * limit of 10. Pulling relations for every result, as the spec notes, would not be: it would be
 * rejected during validation, before any data was read, and the search box would simply stop
 * working.
 *
 * @returns A document taking `$search` and returning each collection under its type identifier.
 */
export function globalSearchQuery(): string {
  const selections = ENTITY_TYPE_IDS.map((id) => {
    const descriptor = ENTITY_TYPES[id];
    return `${id}: ${descriptor.collectionField}(search: $search) { ${summarySelection(descriptor)} }`;
  }).join('\n  ');

  return `query GlobalSearch($search: String) {
  ${selections}
}`;
}
