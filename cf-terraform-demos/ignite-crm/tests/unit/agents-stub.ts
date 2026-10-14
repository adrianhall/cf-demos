/**
 * Node-only placeholder for the Agents SDK used by Worker-entry unit tests.
 */
export function getAgentByName(): never {
  throw new Error('Agents SDK is unavailable in the Node unit test environment.');
}
