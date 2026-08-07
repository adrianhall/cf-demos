/** The finite set of job states visible to editors and persisted in D1. */
export type JobStatus = "queued" | "summarizing" | "generating" | "validating" | "storing" | "ready" | "failed";

/** A product node in a renderer-independent architecture proposal. */
export interface ArchitectureNode {
  /** Stable identifier within one proposal. */
  id: string;
  /** Catalog product identifier. */
  product: string;
}

/** A directed connection between two proposal nodes. */
export interface ArchitectureEdge {
  /** Source node identifier. */
  from: string;
  /** Target node identifier. */
  to: string;
}

/** The proposal shape persisted in R2 after catalog and edge validation. */
export interface ArchitectureProposal {
  /** Nodes selected by the generator. */
  nodes: ArchitectureNode[];
  /** Directed graph edges. */
  edges: ArchitectureEdge[];
}

/** Fixture modes compiled into the local generator for deterministic Workflow probes. */
export type GeneratorFixture = "valid" | "malformed" | "transient" | "exhausted" | "unknown-product" | "invalid-edge";

/** Immutable payload used to create one deterministic Workflow instance. */
export interface ArchitectureJobInput {
  /** Application-owned job and Workflow instance identifier. */
  jobId: string;
  /** Name used to route progress to one Durable Object room. */
  diagramId: string;
  /** Revision captured before proposal generation begins. */
  baseRevision: number;
  /** Deterministic generator behavior selected only by local test fixtures. */
  fixture: GeneratorFixture;
}

/** Progress record persisted by the room so it survives Durable Object eviction. */
export interface ProgressNotification {
  /** Job that changed state. */
  jobId: string;
  /** Persisted job state. */
  status: JobStatus;
  /** Monotonic position assigned by the Durable Object. */
  sequence: number;
  /** Optional deterministic proposal key for ready notifications. */
  proposalKey?: string;
  /** Sanitized terminal failure reason. */
  failureReason?: string;
}
