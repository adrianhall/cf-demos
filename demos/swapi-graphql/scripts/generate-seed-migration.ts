import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The canonical SWAPI resource collections and their local SQL table names. */
const COLLECTIONS = {
  films: "film",
  people: "person",
  planets: "planet",
  species: "species",
  starships: "starship",
  vehicles: "vehicle",
} as const;

/** A GitHub contents API entry used to enumerate a canonical SWAPI collection. */
interface GitHubContentEntry {
  /** Basename of the represented repository entry. */
  name: string;
  /** Whether the entry is a file or a directory. */
  type: string;
}

/** A raw SWAPI resource with scalar fields and relation-reference arrays. */
type SwapiResource = Record<string, unknown>;

/** A many-to-many SQL row represented by its two stable local IDs. */
interface JoinRow {
  /** The local UUID of the left-side entity. */
  leftId: string;
  /** The local UUID of the right-side entity. */
  rightId: string;
}

/** Maximum size for an emitted literal INSERT statement, below D1's 100 KB limit. */
const MAX_STATEMENT_BYTES = 80_000;

/** The fixed namespace makes generated UUIDv5 values stable across seed runs. */
const UUID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** The GitHub repository API base used only while authoring the committed seed migration. */
const GITHUB_API_BASE =
  "https://api.github.com/repos/SivaramPg/swapi.info/contents/public/api";

/** The immutable canonical-resource URL base whose JSON documents seed this demo. */
const SWAPI_RAW_BASE =
  "https://raw.githubusercontent.com/SivaramPg/swapi.info/main/public/api";

/**
 * Fetches JSON and rejects non-success responses with the source URL.
 *
 * @typeParam T - Expected parsed JSON shape.
 * @param url - HTTPS URL to retrieve.
 * @returns The parsed response body.
 * @throws When the request fails or the response is not successful.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

/**
 * Lists the numeric IDs in one canonical SWAPI collection through GitHub's directory API.
 *
 * Each actual resource is subsequently fetched from the raw canonical URL, not this API.
 *
 * @param collection - Canonical plural collection name.
 * @returns Numerically sorted source IDs.
 * @throws When a directory entry is not a numeric JSON resource.
 */
async function fetchCollectionIds(
  collection: keyof typeof COLLECTIONS,
): Promise<string[]> {
  const entries = await fetchJson<GitHubContentEntry[]>(
    `${GITHUB_API_BASE}/${collection}?ref=main`,
  );
  const ids = entries
    .filter((entry) => entry.type === "file" && /^\d+\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort((left, right) => Number(left) - Number(right));

  if (ids.length === 0) {
    throw new Error(`No JSON resources found for ${collection}`);
  }

  return ids;
}

/**
 * Fetches every JSON resource in a canonical SWAPI collection from its raw source URL.
 *
 * @param collection - Canonical plural collection name.
 * @returns Resources keyed by their numeric source ID.
 */
async function fetchCollection(
  collection: keyof typeof COLLECTIONS,
): Promise<Map<string, SwapiResource>> {
  const ids = await fetchCollectionIds(collection);
  const resources = await Promise.all(
    ids.map(async (id) => {
      const resource = await fetchJson<SwapiResource>(
        `${SWAPI_RAW_BASE}/${collection}/${id}.json`,
      );
      return [id, resource] as const;
    }),
  );

  return new Map(resources);
}

/**
 * Converts a UUID string into its 16 binary bytes.
 *
 * @param value - Canonical hyphenated UUID string.
 * @returns UUID bytes in network order.
 */
function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

/**
 * Creates a deterministic UUIDv5 for a canonical SWAPI collection and numeric source ID.
 *
 * @param collection - Canonical plural collection name.
 * @param sourceId - Numeric ID from the upstream resource URL.
 * @returns Stable hyphenated UUIDv5 suitable for a TEXT primary key.
 */
function stableId(
  collection: keyof typeof COLLECTIONS,
  sourceId: string,
): string {
  const digest = createHash("sha1")
    .update(uuidBytes(UUID_NAMESPACE))
    .update(`swapi.info/${collection}/${sourceId}`)
    .digest();

  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Resolves an upstream canonical URL to its deterministic local UUID.
 *
 * @param reference - SWAPI resource URL or an absent optional reference.
 * @returns The matching local UUID, or null for an absent reference.
 * @throws When a non-canonical or unknown resource reference is encountered.
 */
function localId(reference: unknown): string | null {
  if (reference === null || reference === undefined || reference === "") {
    return null;
  }
  if (typeof reference !== "string") {
    throw new Error(`Expected a resource URL, received ${typeof reference}`);
  }

  const match =
    /^https:\/\/swapi\.info\/api\/(films|people|planets|species|starships|vehicles)\/(\d+)\/?$/.exec(
      reference,
    );
  if (!match) {
    throw new Error(`Unsupported SWAPI reference: ${reference}`);
  }

  return stableId(match[1] as keyof typeof COLLECTIONS, match[2]);
}

/**
 * Reads a required scalar source field as text without coercing SWAPI sentinel values.
 *
 * @param resource - Source resource containing the field.
 * @param field - Canonical SWAPI scalar field name.
 * @returns The exact source text, or a decimal string for the film episode identifier.
 * @throws When the source field is absent or neither text nor a number.
 */
function textField(resource: SwapiResource, field: string): string {
  const value = resource[field];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  throw new Error(`Expected ${field} to be text or a number`);
}

/**
 * Reads an upstream relation list and resolves every URL to a local UUID.
 *
 * @param resource - Source resource containing the relation.
 * @param field - Canonical SWAPI relation field name.
 * @returns Local IDs in canonical source order.
 * @throws When the relation is not an array of canonical resource URLs.
 */
function relationIds(resource: SwapiResource, field: string): string[] {
  const value = resource[field];
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an array`);
  }

  return value.map((reference) => {
    const id = localId(reference);
    if (id === null) {
      throw new Error(`Expected ${field} not to contain an empty reference`);
    }
    return id;
  });
}

/**
 * Resolves the optional single species relation stored as SWAPI's zero-or-one array.
 *
 * @param resource - Person source resource containing the species relation.
 * @returns The species local UUID, or null when no species is supplied.
 * @throws When SWAPI supplies more than one species for a person.
 */
function personSpeciesId(resource: SwapiResource): string | null {
  const species = relationIds(resource, "species");
  if (species.length > 1) {
    throw new Error("A person cannot map to more than one species");
  }

  return species[0] ?? null;
}

/**
 * Escapes a SQL literal, normalizing source line endings to LF for a portable migration file.
 * Whitespace immediately before upstream CRLF line breaks is removed to keep generated SQL clean.
 *
 * @param value - Text value or null to serialize.
 * @returns A SQLite-compatible literal with CRLF and CR line endings normalized to LF.
 */
function sqlLiteral(value: string | null): string {
  return value === null
    ? "NULL"
    : `'${value
        .replaceAll(/[ \t]+\r\n/g, "\r\n")
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .replaceAll("'", "''")}'`;
}

/**
 * Emits multiple literal INSERT statements whose UTF-8 byte length remains below D1's limit.
 *
 * @param table - Target SQL table.
 * @param columns - Insert column names in row-value order.
 * @param rows - Literal-ready text or null rows.
 * @returns Complete SQL statements ending with newlines.
 */
function insertStatements(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string[] {
  if (rows.length === 0) {
    return [];
  }

  const prefix = `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n`;
  const suffix = ";\n";
  const statements: string[] = [];
  let values: string[] = [];
  let statementBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);

  for (const row of rows) {
    const value = `  (${row.map(sqlLiteral).join(", ")})`;
    const separatorBytes = values.length === 0 ? 0 : Buffer.byteLength(",\n");
    const valueBytes = Buffer.byteLength(value);
    if (statementBytes + separatorBytes + valueBytes > MAX_STATEMENT_BYTES) {
      if (values.length === 0) {
        throw new Error(`One ${table} row exceeds the D1 statement limit`);
      }
      statements.push(`${prefix}${values.join(",\n")}${suffix}`);
      values = [];
      statementBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
    }

    values.push(value);
    statementBytes += (values.length === 1 ? 0 : separatorBytes) + valueBytes;
  }

  statements.push(`${prefix}${values.join(",\n")}${suffix}`);
  return statements;
}

/**
 * Converts a source collection into local scalar rows in numeric source-ID order.
 *
 * @param collection - Source collection being converted.
 * @param resources - Resources keyed by source ID.
 * @param fields - Source scalar fields to retain after the generated primary key.
 * @param foreignKeys - Optional source fields that become nullable local foreign keys.
 * @returns Rows ordered by numeric source ID.
 */
function entityRows(
  collection: keyof typeof COLLECTIONS,
  resources: Map<string, SwapiResource>,
  fields: readonly string[],
  foreignKeys: Readonly<Record<string, string | null>> = {},
): (string | null)[][] {
  return [...resources.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([sourceId, resource]) => [
      stableId(collection, sourceId),
      ...fields.map((field) => textField(resource, field)),
      ...Object.entries(foreignKeys).map(([field, mode]) =>
        mode === "person-species"
          ? personSpeciesId(resource)
          : localId(resource[field]),
      ),
    ]);
}

/**
 * Derives a local join-table row for each relation reference from a source collection.
 *
 * @param collection - Source collection containing the relation list.
 * @param resources - Resources keyed by source ID.
 * @param relation - Relation field on each source resource.
 * @returns Join rows ordered by source entity then canonical relation order.
 */
function joinRows(
  collection: keyof typeof COLLECTIONS,
  resources: Map<string, SwapiResource>,
  relation: string,
): JoinRow[] {
  return [...resources.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .flatMap(([sourceId, resource]) =>
      relationIds(resource, relation).map((rightId) => ({
        leftId: stableId(collection, sourceId),
        rightId,
      })),
    );
}

/**
 * Fetches all canonical SWAPI resources and writes the committed literal seed migration.
 *
 * @returns Resolves after `migrations/0002_seed.sql` has been replaced atomically by writeFile.
 * @throws When upstream data has an unexpected shape or a reference cannot be mapped locally.
 */
async function main(): Promise<void> {
  const collectionEntries = await Promise.all(
    (Object.keys(COLLECTIONS) as (keyof typeof COLLECTIONS)[]).map(
      async (collection) =>
        [collection, await fetchCollection(collection)] as const,
    ),
  );
  const collections = Object.fromEntries(collectionEntries) as Record<
    keyof typeof COLLECTIONS,
    Map<string, SwapiResource>
  >;

  const statements = [
    "-- Generated once by scripts/generate-seed-migration.ts from swapi.info. Do not regenerate during deployment.\n",
    ...insertStatements(
      "planet",
      [
        "id",
        "name",
        "rotation_period",
        "orbital_period",
        "diameter",
        "climate",
        "gravity",
        "terrain",
        "surface_water",
        "population",
        "created",
        "edited",
        "url",
      ],
      entityRows("planets", collections.planets, [
        "name",
        "rotation_period",
        "orbital_period",
        "diameter",
        "climate",
        "gravity",
        "terrain",
        "surface_water",
        "population",
        "created",
        "edited",
        "url",
      ]),
    ),
    ...insertStatements(
      "species",
      [
        "id",
        "name",
        "classification",
        "designation",
        "average_height",
        "skin_colors",
        "hair_colors",
        "eye_colors",
        "average_lifespan",
        "language",
        "created",
        "edited",
        "url",
        "homeworld_id",
      ],
      entityRows(
        "species",
        collections.species,
        [
          "name",
          "classification",
          "designation",
          "average_height",
          "skin_colors",
          "hair_colors",
          "eye_colors",
          "average_lifespan",
          "language",
          "created",
          "edited",
          "url",
        ],
        { homeworld: "reference" },
      ),
    ),
    ...insertStatements(
      "person",
      [
        "id",
        "name",
        "height",
        "mass",
        "hair_color",
        "skin_color",
        "eye_color",
        "birth_year",
        "gender",
        "created",
        "edited",
        "url",
        "homeworld_id",
        "species_id",
      ],
      entityRows(
        "people",
        collections.people,
        [
          "name",
          "height",
          "mass",
          "hair_color",
          "skin_color",
          "eye_color",
          "birth_year",
          "gender",
          "created",
          "edited",
          "url",
        ],
        { homeworld: "reference", species: "person-species" },
      ),
    ),
    ...insertStatements(
      "film",
      [
        "id",
        "episode_id",
        "title",
        "opening_crawl",
        "director",
        "producer",
        "release_date",
        "created",
        "edited",
        "url",
      ],
      entityRows("films", collections.films, [
        "episode_id",
        "title",
        "opening_crawl",
        "director",
        "producer",
        "release_date",
        "created",
        "edited",
        "url",
      ]),
    ),
    ...insertStatements(
      "starship",
      [
        "id",
        "name",
        "model",
        "manufacturer",
        "cost_in_credits",
        "length",
        "max_atmosphering_speed",
        "crew",
        "passengers",
        "cargo_capacity",
        "consumables",
        "hyperdrive_rating",
        "mglt",
        "starship_class",
        "created",
        "edited",
        "url",
      ],
      entityRows("starships", collections.starships, [
        "name",
        "model",
        "manufacturer",
        "cost_in_credits",
        "length",
        "max_atmosphering_speed",
        "crew",
        "passengers",
        "cargo_capacity",
        "consumables",
        "hyperdrive_rating",
        "MGLT",
        "starship_class",
        "created",
        "edited",
        "url",
      ]),
    ),
    ...insertStatements(
      "vehicle",
      [
        "id",
        "name",
        "model",
        "manufacturer",
        "cost_in_credits",
        "length",
        "max_atmosphering_speed",
        "crew",
        "passengers",
        "cargo_capacity",
        "consumables",
        "vehicle_class",
        "created",
        "edited",
        "url",
      ],
      entityRows("vehicles", collections.vehicles, [
        "name",
        "model",
        "manufacturer",
        "cost_in_credits",
        "length",
        "max_atmosphering_speed",
        "crew",
        "passengers",
        "cargo_capacity",
        "consumables",
        "vehicle_class",
        "created",
        "edited",
        "url",
      ]),
    ),
    ...insertStatements(
      "film_person",
      ["film_id", "person_id"],
      joinRows("films", collections.films, "characters").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "film_planet",
      ["film_id", "planet_id"],
      joinRows("films", collections.films, "planets").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "film_species",
      ["film_id", "species_id"],
      joinRows("films", collections.films, "species").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "film_starship",
      ["film_id", "starship_id"],
      joinRows("films", collections.films, "starships").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "film_vehicle",
      ["film_id", "vehicle_id"],
      joinRows("films", collections.films, "vehicles").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "person_starship",
      ["person_id", "starship_id"],
      joinRows("people", collections.people, "starships").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
    ...insertStatements(
      "person_vehicle",
      ["person_id", "vehicle_id"],
      joinRows("people", collections.people, "vehicles").map(
        ({ leftId, rightId }) => [leftId, rightId],
      ),
    ),
  ];

  await writeFile(
    resolve(import.meta.dirname, "../migrations/0002_seed.sql"),
    statements.join("\n"),
    "utf8",
  );
}

await main();
