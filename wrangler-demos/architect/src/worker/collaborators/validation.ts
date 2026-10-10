import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";

/**
 * A permissive but sane email shape check -- this app never sends a verification email of its
 * own (docs/09C-COLLABORATIVE-EDITING.md's own Non-Goals: adding a collaborator requires that
 * email to already exist in the `users` directory, not a new invitation flow), so this exists
 * only to reject obviously malformed input before it ever reaches a query, not to fully validate
 * RFC 5321 syntax.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Maximum email length this app accepts, matching RFC 5321's overall address length limit. */
const MAX_EMAIL_LENGTH = 320;

/**
 * Validate the `email` field of a `POST /api/diagrams/:id/collaborators` request body.
 *
 * @param value Parsed JSON body.
 * @returns The validated, trimmed email.
 * @throws {ProblemDetailsError} `400` when the body is not an object; `422` when `email` is
 * missing, not a string, too long, or not shaped like an email address. Business-rule
 * rejections -- the email has never signed in, or is the diagram's own owner -- are enforced by
 * `./repository.ts`'s `CollaboratorRepository.add()`, not here.
 */
export function validateAddCollaboratorInput(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }

  const email = Reflect.get(value, "email");
  if (typeof email !== "string") {
    throw unprocessableContent({ detail: "email must be a string." });
  }

  const trimmed = email.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(trimmed)
  ) {
    throw unprocessableContent({
      detail: "email must be a valid email address.",
    });
  }

  return trimmed;
}

/**
 * Assert that a path parameter is a well-formed email address, for
 * `DELETE /api/diagrams/:id/collaborators/:email`.
 *
 * @param email Candidate email from the request path.
 * @returns The validated email.
 * @throws {ProblemDetailsError} When the value is not shaped like an email address --
 * reported identically to "not found" (`404`), matching `../diagrams/validation.ts`'s
 * `validateDiagramId()`: a malformed value and a legitimately unknown collaborator are
 * indistinguishable to the caller.
 */
export function validateCollaboratorEmailParam(email: string): string {
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw notFound({ detail: "Collaborator not found." });
  }
  return email;
}
