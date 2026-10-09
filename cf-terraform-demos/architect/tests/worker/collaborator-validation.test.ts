import { describe, expect, it } from 'vitest';
import {
  rejectSelfCollaboration,
  validateAddCollaboratorInput,
  validateCollaboratorEmail
} from '../../src/worker/domain/collaborator-validation.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the collaboration domain's validation. The rules are deliberately few, so what these
 *   tests mostly establish is where the boundary sits: what the validator refuses, what it
 *   deliberately does not refuse because the real check happens against the user directory, and why
 *   the self-collaboration refusal is a `400` when almost every other refusal on a diagram route is
 *   a `404`.
 */

const ALICE = 'alice@example.com';

describe('validating a collaborator email', () => {
  it('accepts an ordinary address and trims it', () => {
    expect(validateCollaboratorEmail('  someone@example.com  ')).toBe('someone@example.com');
  });

  // Case is deliberately not folded. `users.email` holds whatever the identity provider asserted,
  // and every identity comparison in this application is exact, so treating two spellings as one
  // identity here would widen the set of addable identities beyond the set that actually signed
  // in. The visible consequence is tested in the service suite: a differently-cased address is
  // reported as "has not signed in", like any other unknown one.
  it('preserves case rather than folding it', () => {
    expect(validateCollaboratorEmail('Someone@Example.com')).toBe('Someone@Example.com');
  });

  it.each([
    ['a non-string', 42],
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['no at sign', 'someone.example.com'],
    ['nothing before the at sign', '@example.com'],
    ['nothing after the at sign', 'someone@'],
    ['no dot in the domain', 'someone@example'],
    ['embedded whitespace', 'some one@example.com']
  ])('refuses %s with 422', (_name, value) => {
    expectProblemStatus(() => validateCollaboratorEmail(value), 422);
  });

  it('refuses an address beyond the documented length with 422', () => {
    expectProblemStatus(() => validateCollaboratorEmail(`${'a'.repeat(250)}@example.com`), 422);
  });
});

describe('validating an add-collaborator body', () => {
  it('returns the email the body named', () => {
    expect(validateAddCollaboratorInput({ email: ' someone@example.com ' })).toBe(
      'someone@example.com'
    );
  });

  it.each([
    ['a string', '"someone@example.com"'],
    ['an array', []],
    ['null', null]
  ])('refuses %s as a body with 400', (_name, value) => {
    expectProblemStatus(() => validateAddCollaboratorInput(value), 400);
  });

  it('refuses a body with no email at all with 422', () => {
    expectProblemStatus(() => validateAddCollaboratorInput({}), 422);
  });
});

describe('refusing self-collaboration', () => {
  it('allows two different identities', () => {
    expect(() => rejectSelfCollaboration(ALICE, 'bob@example.com')).not.toThrow();
  });

  // `400`, not the `404` almost every other refusal on a diagram route gives. The non-enumerating
  // posture exists so a caller cannot learn whether an id is real; here they are the owner and
  // named their own address, so there is nothing left to withhold — and a `404` would tell them
  // their own diagram does not exist, which is simply untrue.
  it('refuses the owner naming their own address with 400, not 404', () => {
    expectProblemStatus(() => rejectSelfCollaboration(ALICE, ALICE), 400);
  });

  it('says why, in terms the owner can act on', () => {
    expect(() => rejectSelfCollaboration(ALICE, ALICE)).toThrow(/already own this diagram/u);
  });
});
