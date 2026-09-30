/**
 * @file The shape of the six entity types, as the user interface understands them: what each is
 *   called, which attributes it has and in what order, and which other types it connects to.
 *
 *   ## Why this exists as data rather than as six sets of components
 *
 *   The explorer does the same thing to every type — list it, filter it, show its attributes, show
 *   its relations — and differs only in the details this file records. Writing a `FilmDetail`, a
 *   `PlanetDetail`, and four more would mean six copies of one layout drifting apart, and UISPEC
 *   §6.3's central warning is that _relations differ by type and the UI must not assume otherwise_.
 *   Encoding the differences as data makes the asymmetry impossible to overlook: a type that lacks
 *   a relation simply has no entry for it, and no component has to remember that. This is also what
 *   makes the GraphQL queries honest. `src/ui/api/queries.ts` builds every operation from these
 *   descriptors, so the fields requested are exactly the fields rendered — UISPEC §15's "request
 *   only what is displayed" holds by construction rather than by vigilance.
 *
 *   ## What is deliberately absent
 *
 *   There is no `Planet.species` relation, because the API has none: the data records each species'
 *   homeworld and `Species.homeworld` exposes it, but there is no reverse traversal. See UISPEC
 *   §12.3 — the explorer is required to work without it, and does.
 */

/**
 * Identifier for one of the six entity types.
 *
 * These strings appear in URLs (`/people/<id>`), so they are the plural, lowercase forms a person
 * would expect to see in an address bar rather than the GraphQL type names.
 */
export type EntityTypeId = 'films' | 'people' | 'planets' | 'species' | 'starships' | 'vehicles';

/**
 * Every entity type identifier, in the order the navigation column lists them.
 *
 * Films first because the saga is what most visitors arrive knowing, then characters, then the rest
 * in decreasing likelihood of being the thing someone came to look up.
 */
export const ENTITY_TYPE_IDS: readonly EntityTypeId[] = [
  'films',
  'people',
  'planets',
  'species',
  'starships',
  'vehicles'
];

/**
 * One scalar field as the detail column presents it.
 */
export interface AttributeDescriptor {
  /**
   * GraphQL field name on the entity, also used as the key into a loaded record.
   */
  field: string;
  /**
   * Human-readable label. Written out in full — `Maximum atmosphering speed`, never
   * `maxAtmospheringSpeed` — because UISPEC §6.2 requires labels a reader has not had to learn.
   */
  label: string;
  /**
   * Whether the value is long-form prose needing preserved line breaks and room to breathe.
   *
   * Only a film's opening crawl sets this. It is ~500 characters containing ~20 real newlines, and
   * those breaks are the crawl's original line structure: collapsing them turns it into a wall of
   * prose (UISPEC §6.2).
   */
  longForm?: boolean;
}

/**
 * A named group of attributes, rendered as one block in the detail column.
 *
 * Grouping exists because types have between 10 and 17 scalar fields, which is too many for an
 * undifferentiated list. Each type's first group holds what a reader came for; measurements are
 * gathered together because they are scanned as a set rather than read one at a time.
 */
export interface AttributeGroupDescriptor {
  /**
   * Group heading, or `null` for the leading group whose contents need no introduction.
   */
  title: string | null;
  /**
   * Attributes in this group, in display order.
   */
  attributes: readonly AttributeDescriptor[];
}

/**
 * How one relation is traversed and described.
 */
export interface RelationDescriptor {
  /**
   * GraphQL field name on the parent type.
   */
  field: string;
  /**
   * Panel heading, phrased from the current entity's point of view.
   *
   * `Film.characters` reads as `Characters`; `Person.films` reads as `Appears in`. The raw field
   * name is rarely the right words — UISPEC §6.3.
   */
  label: string;
  /**
   * Type the relation points at, so a click knows where it is going.
   */
  target: EntityTypeId;
  /**
   * Whether the relation yields at most one entity rather than a list.
   *
   * Single-valued relations are presented as one clickable item, never as a list of one, and their
   * absence is stated explicitly rather than rendered as empty space.
   */
  single?: boolean;
  /**
   * Sentence shown when a multi-valued relation is empty, or a single-valued one is null.
   *
   * Spelled out per relation because "No recorded pilots." and "Homeworld not recorded." are the
   * kinds of positive statements UISPEC §9.3 asks for, and a generic "None" is not one.
   */
  emptyLabel: string;
}

/**
 * Everything the explorer needs to know about one entity type.
 */
export interface EntityTypeDescriptor {
  /**
   * Stable identifier, matching the URL segment.
   */
  id: EntityTypeId;
  /**
   * Plural label for the navigation column and collection heading.
   */
  label: string;
  /**
   * Singular label, shown beneath an entity's name so its kind is never ambiguous.
   */
  singular: string;
  /**
   * Root query field returning the whole collection.
   *
   * Almost always the type id, but species breaks the pattern: "species" is its own plural, so the
   * singular field already owns the obvious name and the collection is `speciesList`.
   */
  collectionField: string;
  /**
   * Entity field holding the display name. `title` for films, `name` for everything else.
   */
  displayField: string;
  /**
   * Field providing one line of supporting context in list rows and relation entries, so an item
   * can be recognised without navigating to it (UISPEC §6.3).
   */
  subtitleField: string;
  /**
   * Attribute groups, in display order. Excludes provenance, which every type shares and which
   * `PROVENANCE_ATTRIBUTES` supplies separately.
   */
  attributeGroups: readonly AttributeGroupDescriptor[];
  /**
   * Relations this type has, in the order their panels appear. Deliberately different lengths per
   * type; see the file header.
   */
  relations: readonly RelationDescriptor[];
}

/**
 * Record-level fields shared by every type, shown behind a disclosure.
 *
 * `created`, `edited`, and `url` describe the _record_ rather than its subject, so UISPEC §6.2
 * keeps them visually subordinate. They are not dropped: `url` usefully links to the canonical
 * upstream resource. `id` is deliberately not here — it is plumbing, and the detail view surfaces
 * it separately for anyone who wants to use it in GraphiQL.
 */
export const PROVENANCE_ATTRIBUTES: readonly AttributeDescriptor[] = [
  { field: 'created', label: 'Record created' },
  { field: 'edited', label: 'Record last edited' },
  { field: 'url', label: 'Source URL' }
];

/**
 * Attribute groups shared by starships and vehicles, which differ in only one field.
 *
 * Both describe a craft with the same manufacturer, capacity, and performance attributes; a
 * starship additionally has a hyperdrive rating and an MGLT speed, and each names its class
 * differently. Building both from this base keeps the two presentations genuinely identical
 * wherever the data is identical.
 *
 * @param classField Field naming the craft's class: `starshipClass` or `vehicleClass`.
 * @param classLabel Human label for that field.
 * @param performance Extra performance attributes, empty for vehicles.
 * @returns The attribute groups for that craft type.
 */
function craftAttributeGroups(
  classField: string,
  classLabel: string,
  performance: readonly AttributeDescriptor[]
): readonly AttributeGroupDescriptor[] {
  return [
    {
      title: null,
      attributes: [
        { field: 'model', label: 'Model' },
        { field: classField, label: classLabel },
        { field: 'manufacturer', label: 'Manufacturer' },
        { field: 'costInCredits', label: 'Cost in credits' }
      ]
    },
    {
      title: 'Capacity',
      attributes: [
        { field: 'crew', label: 'Crew' },
        { field: 'passengers', label: 'Passengers' },
        { field: 'cargoCapacity', label: 'Cargo capacity' },
        { field: 'consumables', label: 'Consumables' }
      ]
    },
    {
      title: 'Performance',
      attributes: [
        { field: 'length', label: 'Length' },
        { field: 'maxAtmospheringSpeed', label: 'Maximum atmosphering speed' },
        ...performance
      ]
    }
  ];
}

/**
 * The six entity type descriptors, keyed by identifier.
 *
 * Note how uneven the `relations` arrays are: Film and Person reach five other types each, while
 * Starship and Vehicle reach two. That asymmetry is the data's, not an omission.
 */
export const ENTITY_TYPES: Readonly<Record<EntityTypeId, EntityTypeDescriptor>> = {
  films: {
    id: 'films',
    label: 'Films',
    singular: 'Film',
    collectionField: 'films',
    displayField: 'title',
    subtitleField: 'releaseDate',
    attributeGroups: [
      {
        title: null,
        attributes: [
          { field: 'director', label: 'Director' },
          { field: 'producer', label: 'Producer' },
          { field: 'releaseDate', label: 'Release date' }
        ]
      },
      {
        title: 'Opening crawl',
        attributes: [{ field: 'openingCrawl', label: 'Opening crawl', longForm: true }]
      }
    ],
    relations: [
      {
        field: 'characters',
        label: 'Characters',
        target: 'people',
        emptyLabel: 'No recorded characters.'
      },
      { field: 'planets', label: 'Planets', target: 'planets', emptyLabel: 'No recorded planets.' },
      { field: 'species', label: 'Species', target: 'species', emptyLabel: 'No recorded species.' },
      {
        field: 'starships',
        label: 'Starships',
        target: 'starships',
        emptyLabel: 'No recorded starships.'
      },
      {
        field: 'vehicles',
        label: 'Vehicles',
        target: 'vehicles',
        emptyLabel: 'No recorded vehicles.'
      }
    ]
  },

  people: {
    id: 'people',
    label: 'People',
    singular: 'Character',
    collectionField: 'people',
    displayField: 'name',
    subtitleField: 'birthYear',
    attributeGroups: [
      {
        title: null,
        attributes: [
          { field: 'birthYear', label: 'Birth year' },
          { field: 'gender', label: 'Gender' }
        ]
      },
      {
        title: 'Appearance',
        attributes: [
          { field: 'height', label: 'Height' },
          { field: 'mass', label: 'Mass' },
          { field: 'hairColor', label: 'Hair colour' },
          { field: 'skinColor', label: 'Skin colour' },
          { field: 'eyeColor', label: 'Eye colour' }
        ]
      }
    ],
    relations: [
      {
        field: 'homeworld',
        label: 'Homeworld',
        target: 'planets',
        single: true,
        emptyLabel: 'Homeworld not recorded.'
      },
      {
        field: 'species',
        label: 'Species',
        target: 'species',
        single: true,
        emptyLabel: 'Species not recorded.'
      },
      { field: 'films', label: 'Appears in', target: 'films', emptyLabel: 'No recorded films.' },
      {
        field: 'starships',
        label: 'Starships',
        target: 'starships',
        emptyLabel: 'No recorded starships.'
      },
      {
        field: 'vehicles',
        label: 'Vehicles',
        target: 'vehicles',
        emptyLabel: 'No recorded vehicles.'
      }
    ]
  },

  planets: {
    id: 'planets',
    label: 'Planets',
    singular: 'Planet',
    collectionField: 'planets',
    displayField: 'name',
    subtitleField: 'climate',
    attributeGroups: [
      {
        title: null,
        attributes: [
          { field: 'climate', label: 'Climate' },
          { field: 'terrain', label: 'Terrain' },
          { field: 'population', label: 'Population' }
        ]
      },
      {
        title: 'Measurements',
        attributes: [
          { field: 'diameter', label: 'Diameter' },
          { field: 'gravity', label: 'Gravity' },
          { field: 'rotationPeriod', label: 'Rotation period' },
          { field: 'orbitalPeriod', label: 'Orbital period' },
          { field: 'surfaceWater', label: 'Surface water' }
        ]
      }
    ],
    relations: [
      {
        field: 'residents',
        label: 'Residents',
        target: 'people',
        emptyLabel: 'No recorded residents.'
      },
      { field: 'films', label: 'Appears in', target: 'films', emptyLabel: 'No recorded films.' }
    ]
  },

  species: {
    id: 'species',
    label: 'Species',
    singular: 'Species',
    collectionField: 'speciesList',
    displayField: 'name',
    subtitleField: 'classification',
    attributeGroups: [
      {
        title: null,
        attributes: [
          { field: 'classification', label: 'Classification' },
          { field: 'designation', label: 'Designation' },
          { field: 'language', label: 'Language' }
        ]
      },
      {
        title: 'Physiology',
        attributes: [
          { field: 'averageHeight', label: 'Average height' },
          { field: 'averageLifespan', label: 'Average lifespan' },
          { field: 'skinColors', label: 'Skin colours' },
          { field: 'hairColors', label: 'Hair colours' },
          { field: 'eyeColors', label: 'Eye colours' }
        ]
      }
    ],
    relations: [
      {
        field: 'homeworld',
        label: 'Homeworld',
        target: 'planets',
        single: true,
        emptyLabel: 'Homeworld not recorded.'
      },
      { field: 'people', label: 'Members', target: 'people', emptyLabel: 'No recorded members.' },
      { field: 'films', label: 'Appears in', target: 'films', emptyLabel: 'No recorded films.' }
    ]
  },

  starships: {
    id: 'starships',
    label: 'Starships',
    singular: 'Starship',
    collectionField: 'starships',
    displayField: 'name',
    subtitleField: 'model',
    attributeGroups: craftAttributeGroups('starshipClass', 'Starship class', [
      { field: 'hyperdriveRating', label: 'Hyperdrive rating' },
      { field: 'mglt', label: 'MGLT' }
    ]),
    relations: [
      { field: 'pilots', label: 'Pilots', target: 'people', emptyLabel: 'No recorded pilots.' },
      { field: 'films', label: 'Appears in', target: 'films', emptyLabel: 'No recorded films.' }
    ]
  },

  vehicles: {
    id: 'vehicles',
    label: 'Vehicles',
    singular: 'Vehicle',
    collectionField: 'vehicles',
    displayField: 'name',
    subtitleField: 'model',
    attributeGroups: craftAttributeGroups('vehicleClass', 'Vehicle class', []),
    relations: [
      { field: 'pilots', label: 'Pilots', target: 'people', emptyLabel: 'No recorded pilots.' },
      { field: 'films', label: 'Appears in', target: 'films', emptyLabel: 'No recorded films.' }
    ]
  }
};

/**
 * Look up a descriptor, rejecting anything that is not one of the six types.
 *
 * URLs are user-editable, so an unknown type id is an entirely ordinary thing to receive rather
 * than a bug. Returning `undefined` lets the router answer it with a "not found" view instead of
 * the application throwing on a typo.
 *
 * @param id Candidate type identifier, typically taken straight from a route parameter.
 * @returns The descriptor, or `undefined` when the identifier names no known type.
 */
export function findEntityType(id: string): EntityTypeDescriptor | undefined {
  return ENTITY_TYPE_IDS.includes(id as EntityTypeId)
    ? ENTITY_TYPES[id as EntityTypeId]
    : undefined;
}
