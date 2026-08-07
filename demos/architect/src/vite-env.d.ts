/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Audience for the authenticated Cloudflare Access application. */
  readonly VITE_ACCESS_AUDIENCE?: string;
}
