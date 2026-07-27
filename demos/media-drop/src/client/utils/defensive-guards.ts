/**
 * Determines a suitable error message for a thrown error
 * @param error the error thrown
 * @param defaultMsg the default message
 * @returns a string version of the error
 */
export function getErrorMessage(error: unknown, defaultMsg: string): string {
  return error instanceof Error ? error.message : defaultMsg;
}
