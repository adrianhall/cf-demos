import {
  GraphQLObjectType,
  execute,
  isNonNullType,
  isNullableType,
  parse,
  validate
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { schema } from '../../../src/worker/application/graphql/schema';

/**
 * Read a named object type from the built schema.
 *
 * @param name Type name to look up.
 * @returns The object type.
 * @throws {Error} When the schema has no such object type, which means the type module's
 *   `implement()` call never ran.
 */
function objectType(name: string): GraphQLObjectType {
  const type = schema.getType(name);
  if (!(type instanceof GraphQLObjectType)) {
    throw new Error(`${name} is not an object type in the schema`);
  }
  return type;
}

/**
 * Validate a query document against the schema without executing it.
 *
 * @param source GraphQL document text.
 * @returns The validation errors, empty when the document is valid.
 */
function validationErrors(source: string): readonly Error[] {
  return validate(schema, parse(source));
}

describe('schema', () => {
  it('exposes no mutation type, because this API is read-only', () => {
    // Absence in the published schema is the contract: an introspecting client is told writes do
    // not exist rather than discovering it from a runtime error.
    expect(schema.getMutationType()).toBeUndefined();
  });

  it('exposes no subscription type', () => {
    expect(schema.getSubscriptionType()).toBeUndefined();
  });

  it('defines all six entity types with their fields implemented', () => {
    // Each type module's `implement()` call is a side effect of an import in schema.ts. A dropped
    // import would leave the type declared but empty, which this catches.
    for (const name of ['Film', 'Person', 'Planet', 'Species', 'Starship', 'Vehicle']) {
      expect(Object.keys(objectType(name).getFields()).length).toBeGreaterThan(0);
    }
  });

  it('offers a list and a by-identifier field for every entity', () => {
    const query = objectType('Query').getFields();

    expect(Object.keys(query).toSorted()).toEqual([
      'film',
      'films',
      'people',
      'person',
      'planet',
      'planets',
      'species',
      'speciesList',
      'starship',
      'starships',
      'vehicle',
      'vehicles'
    ]);
  });

  it('makes a by-identifier lookup nullable, so a missing entity is not an error', () => {
    expect(isNullableType(objectType('Query').getFields().film.type)).toBe(true);
  });

  it('requires the identifier argument on a by-identifier lookup', () => {
    const [idArgument] = objectType('Query').getFields().film.args;

    expect(idArgument.name).toBe('id');
    expect(isNonNullType(idArgument.type)).toBe(true);
  });

  it('makes single-valued relations nullable, matching the nullable foreign keys', () => {
    // A droid has no species and some characters have no recorded homeworld. Non-null fields here
    // would turn ordinary gaps in the dataset into query errors.
    expect(isNullableType(objectType('Person').getFields().homeworld.type)).toBe(true);
    expect(isNullableType(objectType('Person').getFields().species.type)).toBe(true);
    expect(isNullableType(objectType('Species').getFields().homeworld.type)).toBe(true);
  });

  it('accepts an optional first argument on every multi-valued relation', () => {
    const relations: [string, string][] = [
      ['Film', 'characters'],
      ['Film', 'planets'],
      ['Film', 'species'],
      ['Film', 'starships'],
      ['Film', 'vehicles'],
      ['Person', 'films'],
      ['Person', 'starships'],
      ['Person', 'vehicles'],
      ['Planet', 'residents'],
      ['Planet', 'films'],
      ['Species', 'people'],
      ['Species', 'films'],
      ['Starship', 'pilots'],
      ['Starship', 'films'],
      ['Vehicle', 'pilots'],
      ['Vehicle', 'films']
    ];

    for (const [typeName, fieldName] of relations) {
      const field = objectType(typeName).getFields()[fieldName];
      const first = field.args.find((argument) => argument.name === 'first');

      expect(first, `${typeName}.${fieldName} should accept first`).toBeDefined();
      // Optional rather than required: omitting it means "no limit".
      expect(isNullableType(first?.type ?? objectType('Film'))).toBe(true);
    }
  });

  it('describes every type and field, so the console documents itself', () => {
    // GraphiQL is this demo's only UI, so its schema explorer is the documentation. An undescribed
    // field would show up there as a blank entry.
    for (const name of ['Film', 'Person', 'Planet', 'Species', 'Starship', 'Vehicle', 'Query']) {
      const type = objectType(name);
      expect(type.description, `${name} should be described`).toBeTruthy();

      for (const field of Object.values(type.getFields())) {
        expect(field.description, `${name}.${field.name} should be described`).toBeTruthy();
      }
    }
  });

  it('validates a deeply nested traversal across the relation cycle', () => {
    // The query the console opens with must actually be valid against the schema.
    expect(
      validationErrors(`{
        films {
          title
          characters(first: 5) {
            name
            homeworld { name climate }
          }
        }
      }`)
    ).toEqual([]);
  });

  it('rejects a query selecting a field that does not exist', () => {
    expect(validationErrors('{ films { notARealField } }')).not.toEqual([]);
  });

  it('rejects an attempted mutation during execution', async () => {
    // `validate()` alone does not catch this. With no mutation type defined there is no schema
    // position for the rule to check the selection against, so the document passes validation and
    // is refused at execution instead. Asserting on the executed result is therefore what actually
    // proves writes are impossible — and it matches what a client sees, which the integration suite
    // confirms over HTTP.
    const result = await execute({
      schema,
      document: parse('mutation { createFilm(title: "x") { id } }')
    });

    expect(result.errors?.[0].message).toContain('mutation');
    expect(result.data ?? null).toBeNull();
  });
});
