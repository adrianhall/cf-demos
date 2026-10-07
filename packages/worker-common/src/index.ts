/**
 * @file Shared Worker-tier building blocks used by every demo in this repository.
 */

export {
  type AccessAudienceEnv,
  type AccessMiddlewareOptions,
  createAccessMiddleware
} from './access.ts';
export { DEFAULT_MAX_REQUEST_BODY_BYTES, jsonBodyLimit } from './body-limit.ts';
export { currentIdentity, currentIdentityEmail, type IdentityEnv } from './identity.ts';
export { createMeRouter, type MeRouterField, type MeRouterOptions } from './me-router.ts';
export { readJsonBody } from './read-json-body.ts';
export { upgradeRequired } from './upgrade-required.ts';
