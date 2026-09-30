import { describe, expect, it } from 'vitest';
import {
  validateCreateTodoInput,
  validateTodoId,
  validateUpdateTodoInput
} from '../../../src/worker/domain/todo-validation';

/**
 * Read the HTTP status a thrown problem-details error carries.
 *
 * The distinction between `400`, `404`, and `422` is part of this module's contract, so the tests
 * assert on the status rather than just "it threw". The status lives on the error's
 * `problemDetails` payload, which is the RFC 9457 document the error handler serializes.
 *
 * @param call Function expected to throw a problem-details error.
 * @returns The status from the thrown error, or `undefined` when nothing was thrown.
 */
function statusOf(call: () => unknown): number | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { problemDetails?: { status?: number } }).problemDetails?.status;
  }
}

const VALID_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

describe('validateCreateTodoInput', () => {
  it('trims a valid title', () => {
    expect(validateCreateTodoInput({ title: '  Buy milk  ' })).toEqual({ title: 'Buy milk' });
  });

  it('accepts a title at the maximum permitted length', () => {
    const title = 'a'.repeat(280);
    expect(validateCreateTodoInput({ title })).toEqual({ title });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'Buy milk'],
    ['a number', 7]
  ])('rejects %s body with 400', (_label, body) => {
    expect(statusOf(() => validateCreateTodoInput(body))).toBe(400);
  });

  it.each([
    ['a missing title', {}],
    ['a non-string title', { title: 42 }],
    ['an empty title', { title: '' }],
    ['a whitespace-only title', { title: '   ' }],
    ['an over-long title', { title: 'a'.repeat(281) }]
  ])('rejects %s with 422', (_label, body) => {
    expect(statusOf(() => validateCreateTodoInput(body))).toBe(422);
  });

  // A misspelled or extra field is rejected rather than ignored, so a client cannot believe it set
  // something the server silently dropped.
  it('rejects an unexpected property with 422', () => {
    expect(statusOf(() => validateCreateTodoInput({ title: 'Buy milk', completed: true }))).toBe(
      422
    );
  });

  // `user_id` is never accepted from the client; the owner comes from the verified Access JWT.
  it('refuses an attempt to set the owner', () => {
    expect(
      statusOf(() => validateCreateTodoInput({ title: 'Buy milk', user_id: 'victim@example.com' }))
    ).toBe(422);
  });
});

describe('validateUpdateTodoInput', () => {
  it('accepts a title-only update', () => {
    expect(validateUpdateTodoInput({ title: ' Renamed ' })).toEqual({ title: 'Renamed' });
  });

  it.each([true, false])('accepts a completed-only update of %s', (completed) => {
    expect(validateUpdateTodoInput({ completed })).toEqual({ completed });
  });

  it('accepts both mutable fields together', () => {
    expect(validateUpdateTodoInput({ completed: true, title: 'Both' })).toEqual({
      completed: true,
      title: 'Both'
    });
  });

  // An empty update would otherwise have to load the task to answer, turning the endpoint into an
  // existence oracle for identifiers the caller does not own.
  it('rejects an empty update with 422', () => {
    expect(statusOf(() => validateUpdateTodoInput({}))).toBe(422);
  });

  it('rejects an unknown field with 422', () => {
    expect(statusOf(() => validateUpdateTodoInput({ completed: true, colour: 'red' }))).toBe(422);
  });

  it('rejects a non-boolean completed with 422', () => {
    expect(statusOf(() => validateUpdateTodoInput({ completed: 'yes' }))).toBe(422);
  });

  it('rejects a non-object body with 400', () => {
    expect(statusOf(() => validateUpdateTodoInput([]))).toBe(400);
  });
});

describe('validateTodoId', () => {
  it('accepts a UUID', () => {
    expect(validateTodoId(VALID_ID)).toBe(VALID_ID);
  });

  // A malformed identifier answers 404 rather than 400/422, so that "not a UUID", "does not
  // exist", and "belongs to somebody else" are indistinguishable to the caller.
  it.each([
    ['an empty string', ''],
    ['a non-UUID word', 'completed'],
    ['a truncated UUID', '5d837139-c37f-4fe3-b95c'],
    ['a SQL fragment', "' OR 1=1 --"],
    ['a path traversal attempt', '../../etc/passwd']
  ])('rejects %s with 404', (_label, id) => {
    expect(statusOf(() => validateTodoId(id))).toBe(404);
  });
});
