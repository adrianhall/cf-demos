import { DurableObject } from "cloudflare:workers";

/**
 * Owns one live diagram's state in later phases.
 *
 * Phase 1 deliberately only registers the SQLite-backed class so deployment, generated bindings,
 * and teardown are exercised before document persistence and WebSocket coordination are added.
 */
export class DiagramRoom extends DurableObject<Env> {}
