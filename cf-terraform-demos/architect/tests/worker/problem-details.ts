import { expect } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';

/**
 * @file Assertion helper for the RFC 9457 errors this demo's domain and application tiers throw. A
 *   plain `expect(...).toThrow()` passes for any error at all, which is the wrong bar here: the
 *   status code is part of the API contract these tiers define. A malformed diagram id answering
 *   `400` instead of `404` would still "throw", while quietly turning the id format into an oracle
 *   a caller could use to distinguish a real diagram from a guessed one. Asserting the status is
 *   what makes that a test failure.
 */

/**
 * Asserts that a synchronous call throws a {@link ProblemDetailsError} with an expected status.
 *
 * @param call Function expected to throw.
 * @param status HTTP status the problem document must carry.
 * @returns Nothing; failures are reported through Vitest's assertions.
 * @throws {Error} When `call` does not throw, throws something other than a
 *   {@link ProblemDetailsError}, or throws one carrying a different status.
 */
export function expectProblemStatus(call: () => unknown, status: number): void {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails.status).toBe(status);
    return;
  }
  expect.unreachable('expected the call to throw a ProblemDetailsError');
}

/**
 * Asserts that a promise rejects with a {@link ProblemDetailsError} carrying an expected status.
 *
 * @param promise Promise expected to reject.
 * @param status HTTP status the problem document must carry.
 * @returns A promise fulfilled once the rejection has been asserted.
 * @throws {Error} When the promise fulfils, or rejects with anything other than a
 *   {@link ProblemDetailsError} carrying `status`.
 */
export async function expectRejectedProblemStatus(
  promise: Promise<unknown>,
  status: number
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ProblemDetailsError);
  await expect(promise).rejects.toMatchObject({ problemDetails: { status } });
}
