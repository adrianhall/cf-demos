import { describe, expect, it } from 'vitest';
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput
} from '../../src/worker/domain/diagram-validation.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the pure metadata rules every transport shares. The most load-bearing assertion here
 *   is the least obvious one: a malformed diagram id is reported as `404`, because the API's whole
 *   non-enumeration contract rests on a caller being unable to tell "not an id" apart from "not
 *   yours".
 */

describe('validateDiagramId', () => {
  it('accepts a well-formed UUID', () => {
    expect(validateDiagramId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it('accepts an uppercase UUID unchanged', () => {
    expect(validateDiagramId('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    );
  });

  // The format must not be an oracle. A caller who can tell a malformed id from an unknown one can
  // confirm that a guessed id is real, which is exactly what the uniform 404 exists to prevent.
  it.each([
    ['a malformed id', 'not-a-uuid'],
    ['an empty id', ''],
    ['a route-shaped id', 'shared-with-me'],
    ['a truncated UUID', '11111111-1111-4111-8111-11111111111'],
    ['a UUID with trailing content', '11111111-1111-4111-8111-111111111111x']
  ])('reports %s as not found rather than as a bad request', (_label, id) => {
    expectProblemStatus(() => validateDiagramId(id), 404);
  });
});

describe('validateCreateDiagramInput', () => {
  // The blank-canvas card sends exactly this.
  it('accepts an empty object, leaving every field unset', () => {
    expect(validateCreateDiagramInput({})).toEqual({});
  });

  it('trims a valid title', () => {
    expect(validateCreateDiagramInput({ title: '  My Diagram  ' })).toEqual({
      title: 'My Diagram'
    });
  });

  it('trims a valid description', () => {
    expect(validateCreateDiagramInput({ description: '  A description  ' })).toEqual({
      description: 'A description'
    });
  });

  it('accepts an explicitly null description', () => {
    expect(validateCreateDiagramInput({ description: null })).toEqual({ description: null });
  });

  it('accepts a blueprint id', () => {
    expect(validateCreateDiagramInput({ blueprintId: 'api-gateway' })).toEqual({
      blueprintId: 'api-gateway'
    });
  });

  it('accepts a title of exactly the maximum length', () => {
    const title = 'a'.repeat(255);

    expect(validateCreateDiagramInput({ title })).toEqual({ title });
  });

  it.each([
    ['a whitespace-only title', { title: '   ' }],
    ['a non-string title', { title: 42 }],
    ['an over-long title', { title: 'a'.repeat(256) }],
    ['an over-long description', { description: 'a'.repeat(2001) }],
    ['a non-string, non-null description', { description: 42 }],
    ['a whitespace-only blueprint id', { blueprintId: '  ' }],
    ['a non-string blueprint id', { blueprintId: 7 }]
  ])('rejects %s as unprocessable', (_label, body) => {
    expectProblemStatus(() => validateCreateDiagramInput(body), 422);
  });

  it.each([
    ['a string body', 'nope'],
    ['a null body', null],
    ['an array body', []]
  ])('rejects %s as a bad request', (_label, body) => {
    expectProblemStatus(() => validateCreateDiagramInput(body), 400);
  });
});

describe('validateUpdateDiagramInput', () => {
  it('accepts a title-only update', () => {
    expect(validateUpdateDiagramInput({ title: 'New Title' })).toEqual({ title: 'New Title' });
  });

  // The distinction this preserves is the whole reason the validator uses `Reflect.has`: `null`
  // clears the description, while omitting the property leaves the stored value alone.
  it('accepts an explicit null description as a request to clear it', () => {
    expect(validateUpdateDiagramInput({ description: null })).toEqual({ description: null });
  });

  it('leaves an omitted description out of the result entirely', () => {
    expect(Reflect.has(validateUpdateDiagramInput({ title: 't' }), 'description')).toBe(false);
  });

  it('accepts both fields together', () => {
    expect(validateUpdateDiagramInput({ description: 'd', title: 't' })).toEqual({
      description: 'd',
      title: 't'
    });
  });

  // A write that changes nothing still bumps `updatedAt` and reorders the dashboard, so it is a
  // mistake worth reporting rather than absorbing.
  it('rejects a body carrying neither field', () => {
    expectProblemStatus(() => validateUpdateDiagramInput({}), 422);
  });

  it('rejects an invalid title even when a valid description is present', () => {
    expectProblemStatus(() => validateUpdateDiagramInput({ description: 'ok', title: '' }), 422);
  });

  it.each([
    ['a string body', 'nope'],
    ['a null body', null],
    ['an array body', []]
  ])('rejects %s as a bad request', (_label, body) => {
    expectProblemStatus(() => validateUpdateDiagramInput(body), 400);
  });
});
