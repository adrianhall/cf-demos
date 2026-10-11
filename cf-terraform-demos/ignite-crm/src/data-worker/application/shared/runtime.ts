/**
 * @file Injectable sources of time and identity, so application tests control both.
 */

/**
 * Clock and identifier source used by every use case.
 */
export interface Runtime {
  /**
   * The current instant.
   *
   * @returns Now.
   */
  now(): Date;
  /**
   * A fresh lowercase UUID.
   *
   * @returns The identifier.
   */
  newId(): string;
}

/**
 * The production runtime: the system clock and `crypto.randomUUID()`.
 */
export const systemRuntime: Runtime = {
  now: () => new Date(),
  newId: () => crypto.randomUUID()
};
