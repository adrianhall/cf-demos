import { forbidden, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';
import { isAdministrator, type Actor } from '../domain/actor';
import { isAuditAction, type AuditEvent, type AuditRepository } from '../domain/audit';

/**
 * Largest number of audit entries one read returns.
 *
 * The audit view exists so an operator can see what recently changed, not to export the trail, so a
 * fixed ceiling is better than client-controlled paging that the first version would get wrong.
 */
export const AUDIT_PAGE_SIZE = 200;

/**
 * Read access to the audit trail.
 *
 * Writing is deliberately not exposed here. Each service records its own actions as part of the
 * operation that caused them, so an entry cannot be written without the change it describes, and
 * there is no general-purpose "record anything" method for a future caller to misuse.
 */
export class AuditService {
  /**
   * @param audit Audit trail port.
   */
  public constructor(private readonly audit: AuditRepository) {}

  /**
   * Read recent audit entries.
   *
   * @param actor Resolved authorization subject.
   * @param action Optional action filter, as supplied in the query string.
   * @returns Matching entries, newest first.
   * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator;
   *   `unprocessableContent()` (422) when the action filter is not a recognized action. An unknown
   *   filter fails rather than being ignored, because silently returning everything would look like
   *   the filter worked.
   * @throws {Error} When the repository rejects the read.
   */
  public async listEvents(
    actor: Actor,
    filters: { action?: string; resource?: string; correlationId?: string }
  ): Promise<AuditEvent[]> {
    if (!isAdministrator(actor)) {
      throw forbidden({ detail: 'Only an administrator may read the audit trail.' });
    }
    if (filters.action !== undefined && !isAuditAction(filters.action)) {
      throw unprocessableContent({ detail: 'Unknown audit action filter.' });
    }
    if (
      (filters.resource !== undefined && !this.isSafeFilter(filters.resource))
      || (filters.correlationId !== undefined && !this.isSafeFilter(filters.correlationId))
    ) {
      throw unprocessableContent({ detail: 'Audit filters contain unsupported characters.' });
    }
    return this.audit.list({
      limit: AUDIT_PAGE_SIZE,
      ...(filters.action === undefined ? {} : { action: filters.action }),
      ...(filters.resource === undefined ? {} : { resource: filters.resource }),
      ...(filters.correlationId === undefined ? {} : { correlationId: filters.correlationId })
    });
  }

  /**
   * Keep audit filters bounded and identifier-like: this endpoint is not a content search surface.
   *
   * @param value Candidate resource or correlation ID filter.
   * @returns Whether the value is safely bounded.
   */
  private isSafeFilter(value: string): boolean {
    return value.length > 0 && value.length <= 200 && /^[a-zA-Z0-9:._-]+$/u.test(value);
  }
}
