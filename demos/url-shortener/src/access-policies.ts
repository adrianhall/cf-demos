/** Shared Cloudflare Access path policies for local development and Worker validation. */
export const accessPolicies = [
  {
    pattern: /^\/api\/links(?:\/|$)/u,
    authenticate: true,
    redirect: false,
  },
  { pattern: /^\/l(?:\/|$)/u, authenticate: false },
];
