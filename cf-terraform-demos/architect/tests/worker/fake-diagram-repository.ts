import type { DiagramRepository } from '../../src/worker/application/ports/diagram-repository.ts';
import type {
  CreateDiagramInput,
  Diagram,
  UpdateDiagramInput
} from '../../src/worker/domain/diagram.ts';
import { DEFAULT_DIAGRAM_TITLE } from '../../src/worker/domain/diagram.ts';

/**
 * @file An in-memory {@link DiagramRepository}, shared by the diagram and share service suites.
 *   Extracted from the diagram suite rather than duplicated, so both describe the same storage
 *   behaviour: a second copy that quietly scoped a read by owner would make one suite's ownership
 *   assertions meaningless while still passing.
 */

/**
 * In-memory {@link DiagramRepository}, deliberately as authorization-neutral as the real adapter.
 *
 * It takes no ownership decisions at all: `find` returns any row by id regardless of owner, and
 * `remove` deletes any row. That is what makes the service suites meaningful — if a service's
 * ownership check were missing, this fake would happily serve one identity another's diagram.
 */
export class FakeDiagramRepository implements DiagramRepository {
  /**
   * Stored rows, keyed by id.
   */
  readonly rows = new Map<string, Diagram>();

  /**
   * Monotonic counter driving both generated ids and timestamps, so ordering assertions do not race
   * a real clock.
   */
  private sequence = 0;

  /**
   * @param ownerEmail Owner to record on the new row.
   * @param input Validated metadata.
   * @param graphData Canonical graph JSON.
   * @returns The stored diagram.
   */
  async create(ownerEmail: string, input: CreateDiagramInput, graphData: string): Promise<Diagram> {
    this.sequence += 1;
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString();
    const diagram: Diagram = {
      createdAt: stamp,
      description: input.description ?? null,
      graphData,
      id: `0000000${this.sequence}-1111-4111-8111-111111111111`,
      ownerEmail,
      title: input.title ?? DEFAULT_DIAGRAM_TITLE,
      updatedAt: stamp
    };
    this.rows.set(diagram.id, diagram);
    return diagram;
  }

  /**
   * @param id Diagram id.
   * @returns The row, regardless of owner, or `null`.
   */
  async find(id: string): Promise<Diagram | null> {
    return this.rows.get(id) ?? null;
  }

  /**
   * @param ownerEmail Owner to filter by.
   * @returns That owner's rows, newest activity first.
   */
  async listByOwner(ownerEmail: string): Promise<Diagram[]> {
    return [...this.rows.values()]
      .filter((row) => row.ownerEmail === ownerEmail)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * @param id Diagram id.
   * @param input Validated fields to write.
   * @returns The updated row, or `null` when absent.
   */
  async updateMetadata(id: string, input: UpdateDiagramInput): Promise<Diagram | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      return null;
    }

    this.sequence += 1;
    const updated: Diagram = {
      ...existing,
      description: input.description === undefined ? existing.description : input.description,
      title: input.title ?? existing.title,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString()
    };
    this.rows.set(id, updated);
    return updated;
  }

  /**
   * @param id Diagram id.
   * @param graphData Canonical graph JSON.
   * @returns The new timestamp, or `null` when absent.
   */
  async replaceGraph(id: string, graphData: string): Promise<string | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      return null;
    }

    this.sequence += 1;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString();
    this.rows.set(id, { ...existing, graphData, updatedAt });
    return updatedAt;
  }

  /**
   * @param id Diagram id.
   * @returns Whether a row was deleted.
   */
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
