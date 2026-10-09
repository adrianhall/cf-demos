import { badRequest, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * @file Collaborator input validation. Pure, like every other module in this tier, so the HTTP API
 *   and any later transport refuse the same values for the same reasons rather than each inventing
 *   its own idea of an addable email.
 */

/**
 * Longest accepted collaborator email.
 *
 * A bound rather than a preference: the value is written into a shared table and echoed back in a
 * list, so an unbounded string would let one grant store bulk text and stretch the modal's layout
 * for everybody who can see it. 254 is the maximum length of an addressable email path per RFC
 * 5321, so the ceiling refuses nothing a real identity provider could assert.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * Shape an addable email must match.
 *
 * Deliberately coarse. The authoritative test of whether an email is addable is not its syntax but
 * whether it is already in the `users` directory — a value that got there by authenticating through
 * Cloudflare Access. This pattern exists only to refuse input that is obviously not an email before
 * it becomes a storage lookup: one `@`, something either side of it, no whitespace, and a dot in
 * the domain. A stricter expression would risk rejecting an address a real identity provider does
 * assert, which is the one failure mode that matters here.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Validates an email supplied as a collaborator target.
 *
 * Whitespace is trimmed, because leading or trailing space is a copy-and-paste artefact rather than
 * part of anybody's identity. Case is deliberately **not** folded: every identity comparison in
 * this application is exact — see `./user.ts`'s `isAdministrator` — and `users.email` holds
 * whatever the identity provider asserted, so treating two spellings as the same identity here
 * would widen the set of identities a grant can name beyond the set that has actually signed in.
 * The visible consequence is that an owner who mistypes the capitalisation is told the person must
 * sign in first, which is the same answer they would get for any other email that is not in the
 * directory.
 *
 * @param value Candidate email from an untrusted request body or path parameter.
 * @returns The trimmed email, exactly as it must appear in the `users` directory to be addable.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not a string, is
 *   empty after trimming, exceeds {@link MAX_EMAIL_LENGTH}, or does not look like an email at all.
 */
export function validateCollaboratorEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw unprocessableContent({ detail: 'email must be a string.' });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) {
    throw unprocessableContent({
      detail: `email must be between 1 and ${MAX_EMAIL_LENGTH} characters.`
    });
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    throw unprocessableContent({ detail: 'email must be a valid email address.' });
  }
  return trimmed;
}

/**
 * Validates an add-collaborator request body.
 *
 * @param value Parsed JSON body.
 * @returns The validated collaborator email the body named.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not a plain object, and
 *   `unprocessableContent()` (422) when its `email` fails {@link validateCollaboratorEmail}.
 */
export function validateAddCollaboratorInput(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest({ detail: 'The request body must be an object.' });
  }

  return validateCollaboratorEmail(Reflect.get(value, 'email'));
}

/**
 * Refuses a grant that would name the diagram's own owner as a collaborator.
 *
 * A business rule rather than a syntactic one, which is why it lives in this tier beside the
 * validators rather than inside the service that happens to call it: the owner already has every
 * capability a collaborator would be given, so the row would grant nothing while making the
 * collaborator list claim the owner is one of its editors.
 *
 * `400` rather than `404`, and deliberately so. The non-enumerating `404` posture exists to stop a
 * caller learning whether a diagram id is real; this refusal discloses nothing they did not already
 * supply, since they are the owner and named their own address. Answering `404` would instead tell
 * an owner their own diagram does not exist, which is simply untrue.
 *
 * @param ownerEmail Verified identity that owns the diagram.
 * @param collaboratorEmail Already-validated email the owner asked to add.
 * @returns Nothing when the two differ.
 * @throws {ProblemDetailsError} `badRequest()` (400) when they are the same identity.
 */
export function rejectSelfCollaboration(ownerEmail: string, collaboratorEmail: string): void {
  if (ownerEmail === collaboratorEmail) {
    throw badRequest({
      detail: 'You already own this diagram, so you cannot add yourself as a collaborator.'
    });
  }
}
