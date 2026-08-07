/**
 * Access rules shared by the Worker and local Vite Access emulator.
 *
 * Production Access applications gate page routes at the edge. The Worker only receives API
 * routes because `assets.run_worker_first` is intentionally limited to API and public resolver
 * paths, but listing page paths here keeps local development equivalent and auditable.
 */
export const accessPolicies = [
  { pattern: /^\/$/u, authenticate: false },
  { pattern: /^\/share(?:\/|$)/u, authenticate: false },
  { pattern: /^\/shared(?:\/|$)/u, authenticate: false },
  { pattern: /^\/app(?:\/|$)/u, authenticate: true, redirect: true },
  { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false },
];
